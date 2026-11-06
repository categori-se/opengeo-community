import json
import re
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action, AuthorizationDenied, Roles, authorize
from opengeo_api.metadata_catalog import (
    ISO_QUALITY_EVALUATION_TYPES,
    ISO_QUALITY_REPORT_TYPES,
    catalog_metadata,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

MetadataFieldType = Literal[
    "string", "number", "boolean", "string_list", "url", "doi", "contacts", "object"
]
MetadataExportTarget = Literal[
    "dcat_3",
    "stac_1_1",
    "ogc_records_1_0",
    "iso_19115_3",
    "schema_org_dataset",
    "datacite_4_7",
    "datacite_4_7_xml",
    "geodcat_ap_3_1",
]
MetadataResult = TypeVar("MetadataResult")
_DOI = re.compile(r"^10\.[0-9]{4,9}/\S+$")
_PUBLIC_HTTPS = re.compile(r"^https://[^\s/?#]+(?:/[^\s]*)?$")
_SPDX_LIKE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+() -]{0,199}$")

# Frozen ISO 3166-1 alpha-2 set from the existing public-domain IANA
# iso3166.tab (ISO/TC 46 N1127, 2024-02-29). No runtime registry/dependency lookup.
_ISO_PRIMARY_COUNTRIES = frozenset(
    [
        "AD",
        "AE",
        "AF",
        "AG",
        "AI",
        "AL",
        "AM",
        "AO",
        "AQ",
        "AR",
        "AS",
        "AT",
        "AU",
        "AW",
        "AX",
        "AZ",
        "BA",
        "BB",
        "BD",
        "BE",
        "BF",
        "BG",
        "BH",
        "BI",
        "BJ",
        "BL",
        "BM",
        "BN",
        "BO",
        "BQ",
        "BR",
        "BS",
        "BT",
        "BV",
        "BW",
        "BY",
        "BZ",
        "CA",
        "CC",
        "CD",
        "CF",
        "CG",
        "CH",
        "CI",
        "CK",
        "CL",
        "CM",
        "CN",
        "CO",
        "CR",
        "CU",
        "CV",
        "CW",
        "CX",
        "CY",
        "CZ",
        "DE",
        "DJ",
        "DK",
        "DM",
        "DO",
        "DZ",
        "EC",
        "EE",
        "EG",
        "EH",
        "ER",
        "ES",
        "ET",
        "FI",
        "FJ",
        "FK",
        "FM",
        "FO",
        "FR",
        "GA",
        "GB",
        "GD",
        "GE",
        "GF",
        "GG",
        "GH",
        "GI",
        "GL",
        "GM",
        "GN",
        "GP",
        "GQ",
        "GR",
        "GS",
        "GT",
        "GU",
        "GW",
        "GY",
        "HK",
        "HM",
        "HN",
        "HR",
        "HT",
        "HU",
        "ID",
        "IE",
        "IL",
        "IM",
        "IN",
        "IO",
        "IQ",
        "IR",
        "IS",
        "IT",
        "JE",
        "JM",
        "JO",
        "JP",
        "KE",
        "KG",
        "KH",
        "KI",
        "KM",
        "KN",
        "KP",
        "KR",
        "KW",
        "KY",
        "KZ",
        "LA",
        "LB",
        "LC",
        "LI",
        "LK",
        "LR",
        "LS",
        "LT",
        "LU",
        "LV",
        "LY",
        "MA",
        "MC",
        "MD",
        "ME",
        "MF",
        "MG",
        "MH",
        "MK",
        "ML",
        "MM",
        "MN",
        "MO",
        "MP",
        "MQ",
        "MR",
        "MS",
        "MT",
        "MU",
        "MV",
        "MW",
        "MX",
        "MY",
        "MZ",
        "NA",
        "NC",
        "NE",
        "NF",
        "NG",
        "NI",
        "NL",
        "NO",
        "NP",
        "NR",
        "NU",
        "NZ",
        "OM",
        "PA",
        "PE",
        "PF",
        "PG",
        "PH",
        "PK",
        "PL",
        "PM",
        "PN",
        "PR",
        "PS",
        "PT",
        "PW",
        "PY",
        "QA",
        "RE",
        "RO",
        "RS",
        "RU",
        "RW",
        "SA",
        "SB",
        "SC",
        "SD",
        "SE",
        "SG",
        "SH",
        "SI",
        "SJ",
        "SK",
        "SL",
        "SM",
        "SN",
        "SO",
        "SR",
        "SS",
        "ST",
        "SV",
        "SX",
        "SY",
        "SZ",
        "TC",
        "TD",
        "TF",
        "TG",
        "TH",
        "TJ",
        "TK",
        "TL",
        "TM",
        "TN",
        "TO",
        "TR",
        "TT",
        "TV",
        "TW",
        "TZ",
        "UA",
        "UG",
        "UM",
        "US",
        "UY",
        "UZ",
        "VA",
        "VC",
        "VE",
        "VG",
        "VI",
        "VN",
        "VU",
        "WF",
        "WS",
        "YE",
        "YT",
        "ZA",
        "ZM",
        "ZW",
    ]
)
# External ISO 3166-1 code-list identifier used by the pinned ISO/TC 211
# FullishV0.0.4 example. CountryCode is not an ISO 19115 hosted code list.
_ISO_COUNTRY_CODELIST = "ISO3166Part1"


def _iso_primary_locale(value: str) -> tuple[str, str | None] | None:
    """Map only a language or explicit language/registered alpha-2 country pair."""
    match = re.fullmatch(r"([A-Za-z]{2,3})(?:-([A-Za-z]{2}))?", value)
    if match is None:
        return None
    language, country = match.groups()
    if country is not None and country.upper() not in _ISO_PRIMARY_COUNTRIES:
        return None
    return language.lower(), country.upper() if country else None


def _iso_quality_unit_label_supported(value: str) -> bool:
    """XML 1.0 characters that survive parse unchanged (CR normalizes to LF)."""
    return all(
        character in "\t\n"
        or 0x20 <= ord(character) <= 0xD7FF
        or 0xE000 <= ord(character) <= 0xFFFD
        or 0x10000 <= ord(character) <= 0x10FFFF
        for character in value
    )


class MetadataStoreUnavailable(RuntimeError):
    pass


class MetadataAccessDenied(RuntimeError):
    pass


class MetadataNotFound(RuntimeError):
    pass


class MetadataConflict(RuntimeError):
    def __init__(self, code: str, *, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class MetadataProfile:
    profile_id: UUID
    slug: str
    title: str
    description: str | None
    version_number: int
    definition: dict[str, Any]
    checksum_sha256: str
    change_message: str | None
    created_by: UUID
    version_created_by: UUID
    created_at: datetime
    updated_at: datetime
    version_created_at: datetime


@dataclass(frozen=True, slots=True)
class MetadataProfileDraft:
    slug: str
    title: str
    description: str | None
    definition: dict[str, Any]
    checksum_sha256: str


@dataclass(frozen=True, slots=True)
class MetadataProfileUpdate:
    expected_version: int
    title: str
    description: str | None
    definition: dict[str, Any]
    checksum_sha256: str
    change_message: str | None


class MetadataProfileRepository(Protocol):
    async def list_profiles(self, context: TenantContext) -> list[MetadataProfile]: ...

    async def get_profile(self, context: TenantContext, profile_id: UUID) -> MetadataProfile: ...

    async def create_profile(
        self, context: TenantContext, draft: MetadataProfileDraft, request_id: str
    ) -> MetadataProfile: ...

    async def update_profile(
        self,
        context: TenantContext,
        profile_id: UUID,
        update: MetadataProfileUpdate,
        request_id: str,
    ) -> MetadataProfile: ...


def canonical_metadata_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def metadata_definition_checksum(value: dict[str, Any]) -> str:
    return sha256(canonical_metadata_json(value)).hexdigest()


def resource_metadata_document(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    return {
        "title": summary.title,
        "abstract": summary.abstract,
        "language": summary.language,
        "license": summary.license,
        "attribution": summary.attribution,
        "keywords": list(summary.keywords),
        "spatial_extent": list(summary.spatial_extent) if summary.spatial_extent else None,
        "temporal_start": summary.temporal_start.isoformat() if summary.temporal_start else None,
        "temporal_end": summary.temporal_end.isoformat() if summary.temporal_end else None,
        "extensions": resource.metadata_extensions,
        "translations": getattr(resource, "translations", {}),
    }


def validate_metadata_document(
    metadata: dict[str, Any], definition: dict[str, Any]
) -> dict[str, Any]:
    issues: list[dict[str, str]] = []

    def issue(severity: Literal["error", "warning"], path: str, code: str, message: str) -> None:
        issues.append({"severity": severity, "path": path, "code": code, "message": message})

    for name in cast(list[str], definition.get("required_core", [])):
        value = metadata.get(name)
        if value is None or value == "" or value == []:
            issue("error", name, "required_core_missing", f"{name} is required by the profile")

    translations = metadata.get("translations")
    if not isinstance(translations, dict):
        translations = {}
    primary_language = str(metadata.get("language") or "").lower()
    translated_languages = {str(language).lower() for language in translations}
    for language in cast(list[str], definition.get("required_languages", [])):
        normalized_language = language.lower()
        if (
            normalized_language != primary_language
            and normalized_language not in translated_languages
        ):
            issue(
                "error",
                f"translations.{normalized_language}",
                "required_language_missing",
                f"a {normalized_language} metadata translation is required by the profile",
            )

    core_vocabularies = cast(dict[str, list[str]], definition.get("core_vocabularies", {}))
    for name, vocabulary in core_vocabularies.items():
        value = metadata.get(name)
        if value is None:
            continue
        values = value if isinstance(value, list) else [value]
        allowed = {item.casefold() for item in vocabulary}
        for item in values:
            if not isinstance(item, str) or item.casefold() not in allowed:
                issue(
                    "error",
                    name,
                    "controlled_vocabulary_mismatch",
                    f"{name} contains a value outside the controlled vocabulary",
                )

    extensions = metadata.get("extensions")
    if not isinstance(extensions, dict):
        extensions = {}
    declared: dict[str, set[str]] = {}
    for field in cast(list[dict[str, Any]], definition.get("extension_fields", [])):
        namespace = cast(str, field["namespace"])
        name = cast(str, field["name"])
        declared.setdefault(namespace, set()).add(name)
        namespace_value = extensions.get(namespace)
        if not isinstance(namespace_value, dict) or name not in namespace_value:
            if field.get("required", False):
                issue(
                    "error",
                    f"extensions.{namespace}.{name}",
                    "required_extension_missing",
                    f"{namespace}.{name} is required by the profile",
                )
            continue
        value = namespace_value[name]
        field_type = cast(MetadataFieldType, field["type"])
        if not _metadata_value_matches(field_type, value):
            issue(
                "error",
                f"extensions.{namespace}.{name}",
                "extension_type_mismatch",
                f"{namespace}.{name} must have type {field_type}",
            )
            continue
        vocabulary = cast(list[str], field.get("vocabulary", []))
        if vocabulary:
            values = value if isinstance(value, list) else [value]
            allowed = {item.casefold() for item in vocabulary}
            if any(not isinstance(item, str) or item.casefold() not in allowed for item in values):
                issue(
                    "error",
                    f"extensions.{namespace}.{name}",
                    "extension_vocabulary_mismatch",
                    f"{namespace}.{name} contains a value outside its vocabulary",
                )

    for namespace, value in extensions.items():
        if namespace not in declared:
            if namespace == "opengeo":
                continue
            issue(
                "warning",
                f"extensions.{namespace}",
                "extension_namespace_preserved",
                "Unregistered extension namespace is preserved without profile validation",
            )
            continue
        if isinstance(value, dict):
            for name in value:
                if name not in declared[namespace]:
                    issue(
                        "warning",
                        f"extensions.{namespace}.{name}",
                        "extension_field_preserved",
                        "Unregistered extension field is preserved without profile validation",
                    )
    errors = sum(item["severity"] == "error" for item in issues)
    warnings = len(issues) - errors
    report: dict[str, Any] = {
        "schemaVersion": "1.0.0",
        "status": "invalid" if errors else "valid",
        "errors": errors,
        "warnings": warnings,
        "issues": issues,
    }
    while len(canonical_metadata_json(report)) > 16_384 and report["issues"]:
        report["issues"].pop()
        report["issuesTruncated"] = True
        report["omittedIssues"] = errors + warnings - len(report["issues"])
    return report


def _metadata_value_matches(field_type: MetadataFieldType, value: Any) -> bool:
    if field_type == "string":
        return isinstance(value, str) and 1 <= len(value) <= 4_000
    if field_type == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if field_type == "boolean":
        return isinstance(value, bool)
    if field_type == "string_list":
        return (
            isinstance(value, list)
            and len(value) <= 128
            and all(isinstance(item, str) and 1 <= len(item) <= 300 for item in value)
        )
    if field_type == "url":
        return isinstance(value, str) and _PUBLIC_HTTPS.fullmatch(value) is not None
    if field_type == "doi":
        return isinstance(value, str) and _DOI.fullmatch(value) is not None
    if field_type == "contacts":
        return _contacts_valid(value)
    return isinstance(value, dict)


def _contacts_valid(value: Any) -> bool:
    if not isinstance(value, list) or len(value) > 32:
        return False
    allowed = {"name", "organization", "email", "role"}
    for contact in value:
        if not isinstance(contact, dict) or not contact or set(contact) - allowed:
            return False
        if not isinstance(contact.get("name"), str) or not 1 <= len(contact["name"]) <= 300:
            return False
        for name in allowed - {"name"}:
            if name in contact and (
                not isinstance(contact[name], str) or not 1 <= len(contact[name]) <= 300
            ):
                return False
    return True


def _iso_contact_unit_losses(catalog: dict[str, Any]) -> list[str]:
    """Name new ISO-only leaves without following graph or external references."""
    losses: list[str] = []

    def visit(value: Any, path: str) -> None:
        if isinstance(value, dict):
            if "title" in value:
                losses.extend(f"{path}.{field}" for field in ("isbn", "issn") if field in value)
            if value.get("type") in {"individual", "organisation"}:
                for index, contact in enumerate(value.get("contacts", [])):
                    contact_path = f"{path}.contacts[{index}]"
                    for field in (
                        "phones",
                        "onlineResources",
                        "hoursOfService",
                        "contactInstructions",
                        "contactType",
                    ):
                        if field in contact:
                            losses.append(f"{contact_path}.{field}")
                    for address_index, address in enumerate(contact.get("addresses", [])):
                        for field in (
                            "deliveryPoints",
                            "city",
                            "administrativeArea",
                            "postalCode",
                            "country",
                        ):
                            if field in address:
                                losses.append(f"{contact_path}.addresses[{address_index}].{field}")
            if value.get("type") == "DQ_QuantitativeResult" and "unitReference" in value:
                losses.append(f"{path}.unitReference")
            for key, item in value.items():
                visit(item, f"{path}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, f"{path}[{index}]")

    for field in ("isoDistributionGroups", "qualityReports", "distributions", "acquisition"):
        visit(catalog.get(field), f"metadata_extensions.opengeo.{field}")
    return losses


def export_dcat_3(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    translations = getattr(resource, "translations", {})
    catalog = catalog_metadata(resource.metadata_extensions)
    mapped = ["title", "identifier", "language", "version", "created_at", "updated_at"]
    titles: list[dict[str, str]] = [
        {"@value": summary.title, "@language": summary.language.lower()}
    ]
    titles.extend(
        {"@value": value["title"], "@language": language.lower()}
        for language, value in sorted(translations.items())
    )
    document: dict[str, Any] = {
        "@context": {
            "dcat": "http://www.w3.org/ns/dcat#",
            "dct": "http://purl.org/dc/terms/",
            "locn": "http://www.w3.org/ns/locn#",
            "prov": "http://www.w3.org/ns/prov#",
            "vcard": "http://www.w3.org/2006/vcard/ns#",
            "dqv": "http://www.w3.org/ns/dqv#",
            "sdmx-attribute": "http://purl.org/linked-data/sdmx/2009/attribute#",
            "spdx": "http://spdx.org/rdf/terms#",
            "xsd": "http://www.w3.org/2001/XMLSchema#",
        },
        "@id": f"urn:uuid:{summary.resource_id}",
        "@type": (
            "dcat:Dataset"
            if summary.kind == "dataset"
            else "dcat:DataService"
            if summary.kind == "service"
            else "dcat:Resource"
        ),
        "dct:identifier": str(summary.resource_id),
        "dct:title": titles[0] if len(titles) == 1 else titles,
        "dct:language": sorted({summary.language.lower(), *translations}),
        "dcat:version": str(summary.version_number),
        "dct:issued": summary.created_at.isoformat(),
        "dct:modified": summary.updated_at.isoformat(),
    }
    optional = {
        "abstract": ("dct:description", summary.abstract),
        "license": ("dct:license", summary.license),
        "attribution": ("dct:rights", summary.attribution),
        "keywords": ("dcat:keyword", list(summary.keywords) or None),
    }
    for source, (target, value) in optional.items():
        if value is not None:
            document[target] = value
            mapped.append(source)
    if translations:
        descriptions = (
            [{"@value": summary.abstract, "@language": summary.language.lower()}]
            if summary.abstract
            else []
        )
        rights = (
            [{"@value": summary.attribution, "@language": summary.language.lower()}]
            if summary.attribution
            else []
        )
        keywords = [
            {"@value": keyword, "@language": summary.language.lower()}
            for keyword in summary.keywords
        ]
        for language, value in sorted(translations.items()):
            normalized_language = language.lower()
            if value.get("abstract"):
                descriptions.append({"@value": value["abstract"], "@language": normalized_language})
            if value.get("attribution"):
                rights.append({"@value": value["attribution"], "@language": normalized_language})
            keywords.extend(
                {"@value": keyword, "@language": normalized_language}
                for keyword in value.get("keywords", [])
            )
        if descriptions:
            document["dct:description"] = descriptions
        if rights:
            document["dct:rights"] = rights
        if keywords:
            document["dcat:keyword"] = keywords
        mapped.append("translations")
    if summary.spatial_extent is not None:
        min_x, min_y, max_x, max_y = summary.spatial_extent
        document["dct:spatial"] = {
            "@type": "dct:Location",
            "locn:geometry": {
                "@value": (
                    f"POLYGON (({min_x} {min_y}, {max_x} {min_y}, {max_x} {max_y}, "
                    f"{min_x} {max_y}, {min_x} {min_y}))"
                ),
                "@type": "http://www.opengis.net/ont/geosparql#wktLiteral",
            },
        }
        mapped.append("spatial_extent")
    if summary.temporal_start is not None or summary.temporal_end is not None:
        temporal: dict[str, Any] = {"@type": "dct:PeriodOfTime"}
        if summary.temporal_start is not None:
            temporal["dcat:startDate"] = summary.temporal_start.isoformat()
        if summary.temporal_end is not None:
            temporal["dcat:endDate"] = summary.temporal_end.isoformat()
        document["dct:temporal"] = temporal
        mapped.append("temporal_extent")
    contacts = cast(list[dict[str, str]], catalog.get("contacts", []))
    if contacts:
        contact_points: list[dict[str, Any]] = []
        creators: list[dict[str, Any]] = []
        publishers: list[dict[str, Any]] = []
        for contact in contacts:
            agent: dict[str, Any] = {"@type": "vcard:Kind"}
            if contact.get("name"):
                agent["vcard:fn"] = contact["name"]
            if contact.get("organization"):
                agent["vcard:organization-name"] = contact["organization"]
            if contact.get("email"):
                agent["vcard:hasEmail"] = {"@id": f"mailto:{contact['email']}"}
            if contact.get("identifier"):
                agent["dct:identifier"] = contact["identifier"]
            contact_points.append(agent)
            if contact.get("role") == "creator":
                creators.append(agent)
            if contact.get("role") == "publisher":
                publishers.append(agent)
        document["dcat:contactPoint"] = contact_points
        if creators:
            document["dct:creator"] = creators
        if publishers:
            document["dct:publisher"] = publishers
        mapped.append("metadata_extensions.opengeo.contacts")
    distributions = cast(list[dict[str, Any]], catalog.get("distributions", []))
    if distributions:
        document["dcat:distribution"] = [
            _dcat_distribution(distribution) for distribution in distributions
        ]
        mapped.append("metadata_extensions.opengeo.distributions")
    lineage = catalog.get("lineage")
    if isinstance(lineage, dict):
        document["dct:provenance"] = lineage["statement"]
        mapped.append("metadata_extensions.opengeo.lineage.statement")
    relationship_sources = [
        f"urn:uuid:{relationship.target_resource_id}"
        for relationship in resource.relationships
        if relationship.source_resource_id == summary.resource_id
        and relationship.relation == "derived_from"
    ]
    catalog_sources = (
        cast(list[str], lineage.get("sources", [])) if isinstance(lineage, dict) else []
    )
    derived = list(dict.fromkeys([*relationship_sources, *catalog_sources]))
    if derived:
        document["prov:wasDerivedFrom"] = derived
        mapped.append("relationships.derived_from")
        if catalog_sources:
            mapped.append("metadata_extensions.opengeo.lineage.sources")
    quality = cast(list[dict[str, Any]], catalog.get("quality", []))
    if quality:
        document["dqv:hasQualityMeasurement"] = [
            _dcat_quality_measurement(measurement) for measurement in quality
        ]
        mapped.append("metadata_extensions.opengeo.quality")
    if catalog.get("updateFrequency"):
        document["dct:accrualPeriodicity"] = catalog["updateFrequency"]
        mapped.append("metadata_extensions.opengeo.updateFrequency")
    if catalog.get("sensitivity"):
        document["dct:accessRights"] = catalog["sensitivity"]
        mapped.append("metadata_extensions.opengeo.sensitivity")
    opengeo_unmapped = [
        f"metadata_extensions.opengeo.{field}"
        for field in (
            "referenceSystems",
            "funding",
            "acquisition",
            "qualityReports",
            "isoDistributionGroups",
        )
        if catalog.get(field)
    ]
    opengeo_unmapped.extend(
        f"metadata_extensions.opengeo.distributions[{index}].isoTransfer.offlineMedia"
        for index, distribution in enumerate(distributions)
        if distribution.get("isoTransfer", {}).get("offlineMedia")
    )
    return {
        "target": "dcat_3",
        "targetVersion": "W3C Recommendation 2024-08-22",
        "mediaType": "application/ld+json",
        "status": (
            "mapped_with_preserved_extensions"
            if set(resource.metadata_extensions) - {"opengeo"} or resource.provenance
            else "mapped_with_explicit_losses"
            if opengeo_unmapped
            else "mapped"
        ),
        "document": document,
        "report": {
            "mapped": mapped,
            "defaulted": [],
            "multilingualLanguages": sorted({summary.language.lower(), *translations}),
            "preservedExtensions": sorted(set(resource.metadata_extensions) - {"opengeo"}),
            "unmapped": ["content", *opengeo_unmapped, *_iso_contact_unit_losses(catalog)]
            + (["provenance"] if resource.provenance else []),
        },
    }


def export_stac_1_1(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    translations = getattr(resource, "translations", {})
    if summary.kind not in {"dataset", "service"}:
        return {
            "target": "stac_1_1",
            "targetVersion": "1.1.0",
            "mediaType": "application/json",
            "status": "not_applicable",
            "document": None,
            "report": {
                "mapped": [],
                "defaulted": [],
                "preservedExtensions": sorted(resource.metadata_extensions),
                "unmapped": ["resource_kind"] + (["translations"] if translations else []),
            },
        }
    catalog = catalog_metadata(resource.metadata_extensions)
    distributions = cast(list[dict[str, Any]], catalog.get("distributions", []))
    defaulted: list[str] = []
    bbox = list(summary.spatial_extent) if summary.spatial_extent else [-180.0, -90.0, 180.0, 90.0]
    if summary.spatial_extent is None:
        defaulted.append("spatial_extent=world")
    interval = [
        summary.temporal_start.isoformat() if summary.temporal_start else None,
        summary.temporal_end.isoformat() if summary.temporal_end else None,
    ]
    if summary.temporal_start is None and summary.temporal_end is None:
        defaulted.append("temporal_extent=open")
    license_value = summary.license or "other"
    if summary.license is None or _SPDX_LIKE.fullmatch(summary.license) is None:
        license_value = "other"
        defaulted.append("license=other")
    if distributions and any(
        value.get("license") != summary.license or not value.get("license")
        for value in distributions
    ):
        license_value = "other"
        defaulted.append("license=other (distribution terms differ or are unknown)")
    document: dict[str, Any] = {
        "type": "Collection",
        "stac_version": "1.1.0",
        "stac_extensions": [],
        "id": str(summary.resource_id),
        "title": summary.title,
        "description": summary.abstract or summary.title,
        "keywords": list(summary.keywords),
        "license": license_value,
        "extent": {"spatial": {"bbox": [bbox]}, "temporal": {"interval": [interval]}},
        "links": [],
    }
    # Namespaced fields preserve exact knowledge without declaring a registered
    # STAC extension or projecting collection terms onto individual distributions.
    document["opengeo:license"] = summary.license
    document["opengeo:metadataExtensions"] = deepcopy(resource.metadata_extensions)
    assets = {}
    for index, distribution in enumerate(distributions, 1):
        if "downloadUrl" not in distribution:
            continue
        asset: dict[str, Any] = {
            "href": distribution["downloadUrl"],
            "opengeo:distribution": deepcopy(distribution),
        }
        for source, target in (("title", "title"), ("mediaType", "type")):
            if source in distribution:
                asset[target] = distribution[source]
        assets[f"distribution-{index}"] = asset
    if assets:
        document["assets"] = assets
    if summary.abstract is None:
        defaulted.append("description=title")
    return {
        "target": "stac_1_1",
        "targetVersion": "1.1.0",
        "mediaType": "application/json",
        "status": "mapped_with_defaults" if defaulted else "mapped",
        "document": document,
        "report": {
            "mapped": [
                "id",
                "title",
                "abstract",
                "keywords",
                "license",
                "spatial_extent",
                "temporal_extent",
                "metadata_extensions (opengeo:metadataExtensions)",
                *(
                    ["metadata_extensions.opengeo.distributions (download assets)"]
                    if assets
                    else []
                ),
            ],
            "defaulted": defaulted,
            "preservedExtensions": sorted(resource.metadata_extensions),
            "unmapped": ["content", "provenance", "relationships"]
            + (["translations"] if translations else []),
        },
    }


def export_schema_org_dataset(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    translations = getattr(resource, "translations", {})
    catalog = catalog_metadata(resource.metadata_extensions)
    if summary.kind != "dataset":
        return _not_applicable_export("schema_org_dataset", "30.0", "application/ld+json", resource)
    titles: list[Any] = [{"@value": summary.title, "@language": summary.language.lower()}]
    descriptions: list[Any] = (
        [{"@value": summary.abstract, "@language": summary.language.lower()}]
        if summary.abstract
        else []
    )
    for language, value in sorted(translations.items()):
        titles.append({"@value": value["title"], "@language": language.lower()})
        if value.get("abstract"):
            descriptions.append({"@value": value["abstract"], "@language": language.lower()})
    document: dict[str, Any] = {
        "@context": "https://schema.org/",
        "@type": "Dataset",
        "@id": f"urn:uuid:{summary.resource_id}",
        "identifier": str(summary.resource_id),
        "name": titles[0] if len(titles) == 1 else titles,
        "inLanguage": sorted({summary.language.lower(), *translations}),
        "keywords": list(summary.keywords),
        "version": str(summary.version_number),
        "dateCreated": summary.created_at.isoformat(),
        "dateModified": summary.updated_at.isoformat(),
    }
    mapped = [
        "identifier",
        "title",
        "language",
        "keywords",
        "version_number",
        "created_at",
        "updated_at",
    ]
    if descriptions:
        document["description"] = descriptions[0] if len(descriptions) == 1 else descriptions
        mapped.append("abstract")
    if summary.license:
        document["license"] = summary.license
        mapped.append("license")
    if summary.attribution:
        document["creditText"] = summary.attribution
        mapped.append("attribution")
    if summary.spatial_extent:
        min_x, min_y, max_x, max_y = summary.spatial_extent
        document["spatialCoverage"] = {
            "@type": "Place",
            "geo": {
                "@type": "GeoShape",
                "box": f"{min_y} {min_x} {max_y} {max_x}",
            },
        }
        mapped.append("spatial_extent")
    temporal = _temporal_interval(summary.temporal_start, summary.temporal_end)
    if temporal:
        document["temporalCoverage"] = temporal
        mapped.append("temporal_extent")
    contacts = cast(list[dict[str, str]], catalog.get("contacts", []))
    if contacts:
        creators: list[dict[str, Any]] = []
        publishers: list[dict[str, Any]] = []
        providers: list[dict[str, Any]] = []
        for contact in contacts:
            agent = _schema_agent(contact)
            if contact.get("role") == "creator":
                creators.append(agent)
            elif contact.get("role") == "publisher":
                publishers.append(agent)
            else:
                providers.append(agent)
        if creators:
            document["creator"] = creators
        if publishers:
            document["publisher"] = publishers
        if providers:
            document["provider"] = providers
        mapped.append("metadata_extensions.opengeo.contacts")
    distributions = cast(list[dict[str, Any]], catalog.get("distributions", []))
    if distributions:
        document["distribution"] = [
            _schema_distribution(distribution) for distribution in distributions
        ]
        mapped.append("metadata_extensions.opengeo.distributions")
    relationship_sources = [
        f"urn:uuid:{relationship.target_resource_id}"
        for relationship in resource.relationships
        if relationship.source_resource_id == summary.resource_id
        and relationship.relation == "derived_from"
    ]
    lineage = catalog.get("lineage")
    catalog_sources = (
        cast(list[str], lineage.get("sources", [])) if isinstance(lineage, dict) else []
    )
    derived = list(dict.fromkeys([*relationship_sources, *catalog_sources]))
    if derived:
        document["isBasedOn"] = derived
        mapped.append("relationships.derived_from")
        if catalog_sources:
            mapped.append("metadata_extensions.opengeo.lineage.sources")
    catalog_unmapped = [
        f"metadata_extensions.opengeo.{field}"
        for field in (
            "referenceSystems",
            "quality",
            "qualityReports",
            "isoDistributionGroups",
            "updateFrequency",
            "sensitivity",
            "funding",
            "acquisition",
            "lineage.statement",
        )
        if (
            (field == "lineage.statement" and isinstance(lineage, dict))
            or (field != "lineage.statement" and catalog.get(field))
        )
    ]
    catalog_unmapped.extend(
        f"metadata_extensions.opengeo.distributions[{index}].isoTransfer.offlineMedia"
        for index, distribution in enumerate(distributions)
        if distribution.get("isoTransfer", {}).get("offlineMedia")
    )
    return {
        "target": "schema_org_dataset",
        "targetVersion": "30.0",
        "mediaType": "application/ld+json",
        "status": "mapped_with_explicit_losses",
        "document": document,
        "documentText": None,
        "report": {
            "mapped": mapped,
            "defaulted": [],
            "multilingualLanguages": sorted({summary.language.lower(), *translations}),
            "preservedExtensions": sorted(set(resource.metadata_extensions) - {"opengeo"}),
            "unmapped": [
                "content",
                "provenance",
                *catalog_unmapped,
                *_iso_contact_unit_losses(catalog),
            ]
            + (["translations.keywords"] if translations else []),
            "conformanceClaimed": False,
        },
    }


# DataCite4.7, datacite/schema@b7713dd7fc399c864b34ebaedbe0e60ce25ab34e.
_DATACITE_REGISTRATION_VOCABULARIES: dict[str, tuple[str, ...]] = {
    "contributorType": (
        "ContactPerson",
        "DataCollector",
        "DataCurator",
        "DataManager",
        "Distributor",
        "Editor",
        "HostingInstitution",
        "Other",
        "Producer",
        "ProjectLeader",
        "ProjectManager",
        "ProjectMember",
        "RegistrationAgency",
        "RegistrationAuthority",
        "RelatedPerson",
        "ResearchGroup",
        "RightsHolder",
        "Researcher",
        "Sponsor",
        "Supervisor",
        "Translator",
        "WorkPackageLeader",
    ),
    "dateType": (
        "Accepted",
        "Available",
        "Collected",
        "Copyrighted",
        "Coverage",
        "Created",
        "Issued",
        "Other",
        "Submitted",
        "Updated",
        "Valid",
        "Withdrawn",
    ),
    "descriptionType": (
        "Abstract",
        "Methods",
        "SeriesInformation",
        "TableOfContents",
        "TechnicalInfo",
        "Other",
    ),
    "funderIdentifierType": ("ISNI", "GRID", "ROR", "Crossref Funder ID", "Other"),
    "nameType": ("Organizational", "Personal"),
    "numberType": ("Article", "Chapter", "Report", "Other"),
    "relatedIdentifierType": (
        "ARK",
        "arXiv",
        "bibcode",
        "CSTR",
        "DOI",
        "EAN13",
        "EISSN",
        "Handle",
        "IGSN",
        "ISBN",
        "ISSN",
        "ISTC",
        "LISSN",
        "LSID",
        "PMID",
        "PURL",
        "RAiD",
        "RRID",
        "SWHID",
        "UPC",
        "URL",
        "URN",
        "w3id",
    ),
    "relationType": (
        "IsCitedBy",
        "Cites",
        "IsSupplementTo",
        "IsSupplementedBy",
        "IsContinuedBy",
        "Continues",
        "IsNewVersionOf",
        "IsPreviousVersionOf",
        "IsPartOf",
        "HasPart",
        "IsPublishedIn",
        "IsReferencedBy",
        "References",
        "IsDocumentedBy",
        "Documents",
        "IsCompiledBy",
        "Compiles",
        "IsVariantFormOf",
        "IsOriginalFormOf",
        "IsIdenticalTo",
        "HasMetadata",
        "IsMetadataFor",
        "Reviews",
        "IsReviewedBy",
        "IsDerivedFrom",
        "IsSourceOf",
        "Describes",
        "IsDescribedBy",
        "HasVersion",
        "IsVersionOf",
        "Requires",
        "IsRequiredBy",
        "Obsoletes",
        "IsObsoletedBy",
        "Collects",
        "IsCollectedBy",
        "HasTranslation",
        "IsTranslationOf",
        "Other",
    ),
    "resourceType": (
        "Audiovisual",
        "Award",
        "Book",
        "BookChapter",
        "Collection",
        "ComputationalNotebook",
        "ConferencePaper",
        "ConferenceProceeding",
        "DataPaper",
        "Dataset",
        "Dissertation",
        "Event",
        "Image",
        "Instrument",
        "InteractiveResource",
        "Journal",
        "JournalArticle",
        "Model",
        "OutputManagementPlan",
        "PeerReview",
        "PhysicalObject",
        "Poster",
        "Preprint",
        "Presentation",
        "Project",
        "Report",
        "Service",
        "Software",
        "Sound",
        "Standard",
        "StudyRegistration",
        "Text",
        "Workflow",
        "Other",
    ),
    "titleType": ("AlternativeTitle", "Subtitle", "TranslatedTitle", "Other"),
}


def _datacite_registration_fields(
    source: dict[str, Any], attributes: dict[str, Any], mapped: list[str], losses: list[str]
) -> None:
    """Project only bounded bibliographic values; they never establish authority."""
    parsed: Any
    contributor_types = _DATACITE_REGISTRATION_VOCABULARIES["contributorType"]

    def text(value: Any, path: str, maximum: int = 1000, *, attribute: bool = False) -> str | None:
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= maximum
            or value != value.strip()
            or not _iso_quality_unit_label_supported(value)
            or (attribute and any(character in "\t\n" for character in value))
        ):
            losses.append(path)
            return None
        mapped.append(path)
        return value

    def record(
        value: Any, path: str, required: set[str], allowed: set[str]
    ) -> dict[str, Any] | None:
        if not isinstance(value, dict) or not required <= value.keys():
            losses.append(path)
            return None
        for key in value.keys() - allowed:
            losses.append(f"{path}.{key}")
        return value

    def objects(value: Any, path: str, maximum: int) -> list[Any]:
        if not isinstance(value, list) or not 1 <= len(value) <= maximum:
            losses.append(path)
            return []
        return value

    def person(value: Any, path: str, contributor: bool) -> dict[str, Any] | None:
        allowed = {
            "name",
            "creatorName",
            "nameType",
            "givenName",
            "familyName",
            "lang",
            "nameIdentifiers",
            "affiliation",
        } | ({"contributorType"} if contributor else set())
        raw = record(value, path, set(), allowed)
        if raw is None:
            return None
        name_key = "name" if "name" in raw else "creatorName"
        name = text(raw.get(name_key), f"{path}.{name_key}", 500)
        if name is None:
            return None
        result: dict[str, Any] = {name_key: name}
        for key in ("nameType", "givenName", "familyName", "lang"):
            if key not in raw:
                continue
            candidate = raw[key]
            if (
                key == "nameType"
                and (
                    not isinstance(candidate, str)
                    or candidate not in {"Personal", "Organizational"}
                )
            ) or (
                key == "lang"
                and (
                    not isinstance(candidate, str)
                    or re.fullmatch(r"[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*", candidate) is None
                )
            ):
                losses.append(f"{path}.{key}")
            elif (parsed := text(candidate, f"{path}.{key}", 300)) is not None:
                result[key] = parsed
        if contributor:
            if (
                not isinstance(raw.get("contributorType"), str)
                or raw["contributorType"] not in contributor_types
            ):
                losses.append(f"{path}.contributorType")
                return None
            result["contributorType"] = raw["contributorType"]
            mapped.append(f"{path}.contributorType")
        for field, required, allowed_fields, maximum in (
            (
                "nameIdentifiers",
                {"nameIdentifier", "nameIdentifierScheme"},
                {"nameIdentifier", "nameIdentifierScheme", "schemeUri"},
                8,
            ),
            (
                "affiliation",
                {"name"},
                {"name", "affiliationIdentifier", "affiliationIdentifierScheme", "schemeUri"},
                16,
            ),
        ):
            if field not in raw:
                continue
            items: list[Any] = []
            for index, item in enumerate(objects(raw[field], f"{path}.{field}", maximum)):
                item_path = f"{path}.{field}[{index}]"
                if field == "affiliation" and isinstance(item, str):
                    parsed_text = text(item, item_path)
                    if parsed_text is not None:
                        items.append(parsed_text)
                    continue
                value_record = record(item, item_path, required, allowed_fields)
                if value_record is None:
                    continue
                parsed_record = {}
                for key in allowed_fields & value_record.keys():
                    parsed_text = text(
                        value_record[key],
                        f"{item_path}.{key}",
                        2048,
                        attribute=key not in {"name", "nameIdentifier"},
                    )
                    if parsed_text is not None:
                        parsed_record[key] = parsed_text
                if required <= parsed_record.keys():
                    items.append(parsed_record)
                else:
                    mapped[:] = [entry for entry in mapped if not entry.startswith(item_path + ".")]
            if items:
                result[field] = items
        return result

    publisher = attributes["publisher"]
    if isinstance(publisher, dict):
        raw_publisher = record(
            publisher,
            "publisher",
            {"name"},
            {"name", "publisherIdentifier", "publisherIdentifierScheme", "schemeUri", "lang"},
        )
        projected_publisher = {}
        if raw_publisher is not None:
            for key in sorted(
                raw_publisher.keys()
                & {"name", "publisherIdentifier", "publisherIdentifierScheme", "schemeUri", "lang"}
            ):
                value = raw_publisher[key]
                if key == "lang" and (
                    not isinstance(value, str)
                    or re.fullmatch(r"[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*", value) is None
                ):
                    losses.append("publisher.lang")
                    continue
                parsed = text(value, f"publisher.{key}", 2048, attribute=key != "name")
                if parsed is not None:
                    projected_publisher[key] = parsed
        attributes["publisher"] = projected_publisher if "name" in projected_publisher else None
    else:
        attributes["publisher"] = text(publisher, "publisher", 2000)

    creators = []
    for index, value in enumerate(attributes["creators"]):
        previous = len(mapped)
        parsed = person(value, f"creators[{index}]", False)
        if parsed is not None:
            creators.append(parsed)
        else:
            del mapped[previous:]
    attributes["creators"] = creators
    for field in ("contributors", "alternateIdentifiers", "formats", "sizes"):
        if field not in source:
            continue
        projected = []
        for index, value in enumerate(
            objects(source[field], field, 100 if field == "contributors" else 32)
        ):
            path = f"{field}[{index}]"
            previous = len(mapped)
            if field in {"formats", "sizes"}:
                parsed = text(value, path)
            elif field == "contributors":
                parsed = person(value, path, True)
            else:
                required = {"alternateIdentifier", "alternateIdentifierType"}
                raw = record(value, path, required, required)
                parsed = {}
                if raw is not None:
                    for key in sorted(required):
                        part = text(
                            raw[key],
                            f"{path}.{key}",
                            2048,
                            attribute=key != "alternateIdentifier",
                        )
                        if part is not None:
                            parsed[key] = part
                if not required <= parsed.keys():
                    parsed = None
            if parsed is not None:
                projected.append(parsed)
            else:
                del mapped[previous:]
        if projected:
            attributes[field] = projected


def _datacite_complete_registration_fields(
    source: dict[str, Any], attributes: dict[str, Any], mapped: list[str], losses: list[str]
) -> None:
    """Project the remaining fixed DataCite4.7 registration shapes, without I/O."""
    invalid = object()
    accepted: list[str] = []
    locations: dict[int, str] = {}
    vocab = _DATACITE_REGISTRATION_VOCABULARIES
    Parser = Callable[[Any, str], Any]

    def string(enum: str | None = None, *, attribute: bool = False) -> Parser:
        def parse(value: Any, path: str) -> Any:
            if (
                not isinstance(value, str)
                or len(value) > 8000
                or not _iso_quality_unit_label_supported(value)
                or (attribute and any(character in "\t\n" for character in value))
                or (enum is not None and value not in vocab[enum])
            ):
                losses.append(path)
                return invalid
            accepted.append(path)
            return value

        return parse

    text = string()
    attribute_text = string(attribute=True)

    def language(value: Any, path: str) -> Any:
        if (
            not isinstance(value, str)
            or re.fullmatch(r"[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*", value) is None
        ):
            losses.append(path)
            return invalid
        accepted.append(path)
        return value

    def record(
        value: Any, path: str, fields: dict[str, Parser], required: tuple[str, ...] = ()
    ) -> Any:
        if not isinstance(value, dict):
            losses.append(path)
            return invalid
        previous = len(accepted)
        result = {}
        for key, raw in value.items():
            if key not in fields:
                losses.append(f"{path}.{key}")
                continue
            parsed = fields[key](raw, f"{path}.{key}")
            if parsed is not invalid:
                result[key] = parsed
        if any(key not in result for key in required):
            losses.extend(accepted[previous:])
            del accepted[previous:]
            losses.append(path)
            return invalid
        locations[id(result)] = path
        return result

    def array(parser: Parser, minimum: int = 0, maximum: int = 100) -> Parser:
        def parse(value: Any, path: str) -> Any:
            if not isinstance(value, list) or not minimum <= len(value) <= maximum:
                losses.append(path)
                return invalid
            previous = len(accepted)
            result = []
            for index, item in enumerate(value):
                parsed = parser(item, f"{path}[{index}]")
                if parsed is not invalid:
                    result.append(parsed)
            if len(result) < minimum:
                losses.extend(accepted[previous:])
                del accepted[previous:]
                losses.append(path)
                return invalid
            locations[id(result)] = path
            return result

        return parse

    def object_parser(fields: dict[str, Parser], required: tuple[str, ...] = ()) -> Parser:
        return lambda value, path: record(value, path, fields, required)

    def year(value: Any, path: str) -> Any:
        if (isinstance(value, int) and not isinstance(value, bool) and 1000 <= value <= 9999) or (
            isinstance(value, str) and re.fullmatch(r"[0-9]{4}", value) is not None
        ):
            accepted.append(path)
            return value
        losses.append(path)
        return invalid

    def coordinate(bound: int) -> Parser:
        def parse(value: Any, path: str) -> Any:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not -bound <= value <= bound
            ):
                losses.append(path)
                return invalid
            accepted.append(path)
            return value

        return parse

    title = object_parser(
        {"title": text, "titleType": string("titleType", attribute=True), "lang": language},
        ("title",),
    )
    point = object_parser(
        {"pointLongitude": coordinate(180), "pointLatitude": coordinate(90)},
        ("pointLongitude", "pointLatitude"),
    )
    box = object_parser(
        {
            key: coordinate(180 if "Longitude" in key else 90)
            for key in (
                "westBoundLongitude",
                "eastBoundLongitude",
                "southBoundLatitude",
                "northBoundLatitude",
            )
        },
        ("westBoundLongitude", "eastBoundLongitude", "southBoundLatitude", "northBoundLatitude"),
    )

    def polygon(value: Any, path: str) -> Any:
        if not isinstance(value, dict) or ("polygonPoint" in value) == ("polygonPoints" in value):
            losses.append(path)
            return invalid
        key = "polygonPoint" if "polygonPoint" in value else "polygonPoints"
        previous = len(accepted)
        result = record(value, path, {key: array(point, 4, 256), "inPolygonPoint": point}, (key,))
        if result is not invalid and result[key][0] != result[key][-1]:
            losses.extend(accepted[previous:])
            del accepted[previous:]
            losses.append(path + ".[unclosed-ring]")
            return invalid
        return result

    geography = object_parser(
        {
            "geoLocationPlace": text,
            "geoLocationPoint": point,
            "geoLocationBox": box,
            "geoLocationPolygon": array(polygon, 0, 16),
        }
    )
    related_identifier_fields = {
        "relatedIdentifier": text,
        "relatedIdentifierType": string("relatedIdentifierType", attribute=True),
        "relationType": string("relationType", attribute=True),
        "relatedMetadataScheme": attribute_text,
        "schemeUri": attribute_text,
        "schemeType": attribute_text,
        "resourceTypeGeneral": string("resourceType", attribute=True),
        "relationTypeInformation": attribute_text,
    }
    related_person_fields = {
        "name": text,
        "nameType": string("nameType", attribute=True),
        "givenName": text,
        "familyName": text,
        "lang": language,
    }
    related_creator = object_parser(related_person_fields, ("name",))
    related_contributor = object_parser(
        {**related_person_fields, "contributorType": string("contributorType", attribute=True)},
        ("name", "contributorType"),
    )
    related_item_fields = {
        "relatedItemType": string("resourceType", attribute=True),
        "relationType": string("relationType", attribute=True),
        "relationTypeInformation": attribute_text,
        "relatedItemIdentifier": object_parser(
            {
                "relatedItemIdentifier": text,
                "relatedItemIdentifierType": string("relatedIdentifierType", attribute=True),
                "relatedMetadataScheme": attribute_text,
                "schemeURI": attribute_text,
                "schemeType": attribute_text,
            },
            ("relatedItemIdentifier",),
        ),
        "creators": array(related_creator),
        "titles": array(title),
        "publicationYear": year,
        "volume": text,
        "issue": text,
        "number": text,
        "numberType": string("numberType", attribute=True),
        "firstPage": text,
        "lastPage": text,
        "publisher": text,
        "edition": text,
        "contributors": array(related_contributor),
    }

    def related_item(value: Any, path: str) -> Any:
        result = record(value, path, related_item_fields, ("relatedItemType", "relationType"))
        if result is not invalid and "numberType" in result and "number" not in result:
            del result["numberType"]
            losses.append(path + ".numberType")
            accepted[:] = [entry for entry in accepted if entry != path + ".numberType"]
        return result

    def funding(value: Any, path: str) -> Any:
        fields = {
            "funderName": text,
            "funderIdentifier": text,
            "funderIdentifierType": string("funderIdentifierType", attribute=True),
            "schemeUri": attribute_text,
            "awardNumber": text,
            "awardUri": attribute_text,
            "awardTitle": text,
        }
        result = record(value, path, fields, ("funderName",))
        if result is invalid:
            return result
        for key, dependency in (
            ("funderIdentifier", "funderIdentifierType"),
            ("funderIdentifierType", "funderIdentifier"),
            ("schemeUri", "funderIdentifier"),
            ("awardUri", "awardNumber"),
        ):
            if key in result and dependency not in result:
                del result[key]
                losses.append(path + "." + key)
                accepted[:] = [entry for entry in accepted if entry != path + "." + key]
        return result

    schemas = {
        "titles": array(title, 1),
        "subjects": array(
            object_parser(
                {
                    "subject": text,
                    "subjectScheme": attribute_text,
                    "schemeUri": attribute_text,
                    "valueUri": attribute_text,
                    "classificationCode": attribute_text,
                    "lang": language,
                },
                ("subject",),
            )
        ),
        "dates": array(
            object_parser(
                {
                    "date": text,
                    "dateType": string("dateType", attribute=True),
                    "dateInformation": attribute_text,
                },
                ("date", "dateType"),
            )
        ),
        "rightsList": array(
            object_parser(
                {
                    "rights": text,
                    "rightsUri": attribute_text,
                    "rightsIdentifier": attribute_text,
                    "rightsIdentifierScheme": attribute_text,
                    "schemeUri": attribute_text,
                    "lang": language,
                },
                ("rights",),
            )
        ),
        "descriptions": array(
            object_parser(
                {
                    "description": text,
                    "descriptionType": string("descriptionType", attribute=True),
                    "lang": language,
                },
                ("description", "descriptionType"),
            )
        ),
        "geoLocations": array(geography),
        "relatedIdentifiers": array(
            object_parser(
                related_identifier_fields,
                ("relatedIdentifier", "relatedIdentifierType", "relationType"),
            )
        ),
        "relatedItems": array(related_item),
        "types": object_parser(
            {"resourceTypeGeneral": string("resourceType", attribute=True), "resourceType": text},
            ("resourceTypeGeneral",),
        ),
        "version": text,
        "fundingReferences": array(funding),
    }

    def paths(value: Any, path: str) -> list[str]:
        if isinstance(value, dict):
            return [leaf for key, child in value.items() for leaf in paths(child, f"{path}.{key}")]
        if isinstance(value, list):
            return [
                leaf
                for index, child in enumerate(value)
                for leaf in paths(child, f"{path}[{index}]")
            ]
        return [path]

    def reject(value: Any, path: str) -> None:
        path = locations.get(id(value), path)
        removed = [
            entry
            for entry in accepted
            if entry == path or entry.startswith(path + ".") or entry.startswith(path + "[")
        ]
        losses.extend(removed or paths(value, path))
        accepted[:] = [entry for entry in accepted if entry not in removed]

    def lang(value: dict[str, Any]) -> str:
        return str(value.get("lang", attributes.get("language", "en"))).lower()

    def dates_equal(first: Any, second: Any) -> bool:
        def bounds(value: Any) -> tuple[datetime | None, ...] | None:
            if value is None:
                return None
            try:
                result: list[datetime | None] = []
                for part in str(value).split("/"):
                    if part in {"", ".."}:
                        result.append(None)
                    else:
                        stamp = datetime.fromisoformat(part.replace("Z", "+00:00"))
                        result.append(
                            stamp.replace(tzinfo=UTC)
                            if stamp.tzinfo is None
                            else stamp.astimezone(UTC)
                        )
                return tuple(result)
            except ValueError:
                return None

        return bounds(first) == bounds(second)

    for field, parser in schemas.items():
        if field not in source:
            continue
        previous = len(accepted)
        clean = parser(source[field], field)
        if clean is invalid:
            continue
        native = attributes.get(field)
        if field in {"titles", "subjects", "descriptions"}:
            current = native or []
            key = {"titles": "title", "subjects": "subject", "descriptions": "description"}[field]
            projected = []
            baselines: dict[str, tuple[int, str]] = {}
            for raw in source[field]:
                if not isinstance(raw, dict) or not isinstance(raw.get(key), str):
                    continue
                primary = field == "descriptions" and raw.get("descriptionType") == "Abstract"
                title_kind = raw.get("titleType")
                title_primary = field == "titles" and (
                    title_kind is None or title_kind == "TranslatedTitle"
                )
                if primary or title_primary:
                    priority = 1 if title_kind == "TranslatedTitle" else 0
                    language_key = lang(raw)
                    if language_key not in baselines or priority < baselines[language_key][0]:
                        baselines[language_key] = (priority, raw[key])
            for index, value in enumerate(clean):
                controlled = (
                    field == "subjects"
                    or (
                        field == "titles"
                        and value.get("titleType") not in {"AlternativeTitle", "Subtitle", "Other"}
                    )
                    or (field == "descriptions" and value["descriptionType"] == "Abstract")
                )
                expected = (
                    baselines.get(lang(value), (0, value[key]))[1]
                    if controlled and field != "subjects"
                    else value[key]
                )
                matches = [
                    item
                    for item in current
                    if item[key] == expected and (field == "subjects" or lang(item) == lang(value))
                ]
                if controlled and not matches:
                    reject(value, f"{field}[{index}]")
                else:
                    projected.append(value)
            missing_native = [
                item
                for item in current
                if not any(
                    value[key] == item[key] and (field == "subjects" or lang(value) == lang(item))
                    for value in projected
                )
            ]
            clean = missing_native + projected
        elif field == "rightsList":
            raw_first = (
                source[field][0] if source[field] and isinstance(source[field][0], dict) else {}
            )
            baseline = (
                raw_first.get("rightsIdentifier")
                or raw_first.get("rightsUri")
                or raw_first.get("rights")
            )
            native_license = native[0].get("rights") if native else None
            if native_license != baseline:
                reject(clean, field)
                continue
        elif field == "dates":
            coverage = next(
                (value["date"] for value in native or [] if value.get("dateType") == "Coverage"),
                None,
            )
            retained_dates = []
            for value in clean:
                if value["dateType"] != "Coverage" or dates_equal(value["date"], coverage):
                    retained_dates.append(value)
                else:
                    reject(value, "dates.Coverage")
            clean = retained_dates
            for value in native or []:
                if value not in clean and value.get("dateType") != "Coverage":
                    clean.append(value)
            if coverage is not None and not any(value["dateType"] == "Coverage" for value in clean):
                clean.extend(value for value in native or [] if value.get("dateType") == "Coverage")
        elif (
            field == "types"
            and clean.get("resourceTypeGeneral") != attributes["types"]["resourceTypeGeneral"]
        ):
            reject(clean, field)
            continue
        elif field == "geoLocations":
            boxes = [value["geoLocationBox"] for value in clean if "geoLocationBox" in value]
            baseline = (
                {
                    key: (min if key.startswith(("west", "south")) else max)(
                        value[key] for value in boxes
                    )
                    for key in boxes[0]
                }
                if boxes
                else None
            )
            current_box = (native or [{}])[0].get("geoLocationBox")
            if current_box != baseline:
                reject(clean, field)
                continue
        elif field == "fundingReferences" and native is not None and clean != native:
            reject(clean, field)
            continue
        if field == "relatedIdentifiers":
            clean.extend(value for value in native or [] if value not in clean)
        attributes[field] = clean
        mapped.extend(accepted[previous:])


def export_datacite_4_7(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    native_types = {
        "dataset": "Dataset",
        "service": "Service",
        "document": "Text",
        "map": "Image",
        "story": "InteractiveResource",
        "dashboard": "InteractiveResource",
    }
    if summary.kind not in native_types:
        return _not_applicable_export("datacite_4_7", "4.7", "application/vnd.api+json", resource)
    extensions = resource.metadata_extensions
    datacite = extensions.get("datacite", {})
    research = extensions.get("research", {})
    catalog = catalog_metadata(extensions)
    if not isinstance(datacite, dict):
        datacite = {}
    if not isinstance(research, dict):
        research = {}
    doi = datacite.get("doi") or research.get("doi")
    creators = datacite.get("creators")
    if not isinstance(creators, list):
        contacts = catalog.get("contacts") or research.get("contacts", [])
        creators = (
            [
                {"name": contact["name"]}
                for contact in contacts
                if isinstance(contact, dict)
                and isinstance(contact.get("name"), str)
                and contact.get("role") in {"author", "creator", "principalInvestigator"}
            ]
            if isinstance(contacts, list)
            else []
        )
    creators = [
        creator
        for creator in creators
        if isinstance(creator, dict)
        and isinstance(creator.get("name") or creator.get("creatorName"), str)
    ]
    imported_datacite = getattr(resource, "provenance", {}).get("sourceFormat") == "datacite_4_7"
    native_contacts_explicit = "contacts" in catalog or (
        imported_datacite and "opengeo" in extensions
    )
    if native_contacts_explicit and not any(
        contact.get("role") in {"author", "creator", "principalInvestigator"}
        for contact in catalog.get("contacts", [])
    ):
        creators = []
    catalog_publisher = next(
        (
            contact.get("organization") or contact.get("name")
            for contact in cast(list[dict[str, str]], catalog.get("contacts", []))
            if contact.get("role") == "publisher"
        ),
        None,
    )
    retained_publisher = datacite.get("publisher")
    publisher_value = (
        retained_publisher
        if isinstance(retained_publisher, dict)
        and retained_publisher.get("name") == catalog_publisher
        else catalog_publisher or retained_publisher or summary.attribution
    )
    if native_contacts_explicit and catalog_publisher is None:
        publisher_value = None
    publisher = (
        publisher_value.get("name") if isinstance(publisher_value, dict) else publisher_value
    )
    valid_doi = isinstance(doi, str) and _DOI.fullmatch(doi) is not None
    valid_publisher = isinstance(publisher, str) and 1 <= len(publisher.strip()) <= 2_000
    publication_year = datacite.get("publicationYear", summary.created_at.year)
    valid_publication_year = (
        not isinstance(publication_year, bool)
        and isinstance(publication_year, int)
        and 1000 <= publication_year <= 9999
    )
    missing = [
        name
        for name, value in (
            ("doi", valid_doi),
            ("creators", creators),
            ("publisher", valid_publisher),
            ("publicationYear", valid_publication_year),
        )
        if not value
    ]
    if missing:
        result = _not_applicable_export("datacite_4_7", "4.7", "application/vnd.api+json", resource)
        result["status"] = "not_exportable_missing_required_metadata"
        result["report"]["missingRequired"] = missing
        result["report"]["conformanceClaimed"] = False
        return result
    general = native_types[summary.kind]
    retained_types = datacite.get("types")
    retained_general = (
        retained_types.get("resourceTypeGeneral") if isinstance(retained_types, dict) else None
    )
    if (
        isinstance(retained_general, str)
        and retained_general in _DATACITE_REGISTRATION_VOCABULARIES["resourceType"]
    ):
        retained_kind = (
            "dataset"
            if retained_general in {"Dataset", "Collection"}
            else "service"
            if retained_general == "Service"
            else "document"
        )
        if retained_kind == summary.kind:
            general = retained_general
    translations = getattr(resource, "translations", {})
    titles = [{"title": summary.title, "lang": summary.language.lower()}]
    descriptions = (
        [
            {
                "description": summary.abstract,
                "descriptionType": "Abstract",
                "lang": summary.language.lower(),
            }
        ]
        if summary.abstract
        else []
    )
    for language, value in sorted(translations.items()):
        titles.append({"title": value["title"], "lang": language.lower()})
        if value.get("abstract"):
            descriptions.append(
                {
                    "description": value["abstract"],
                    "descriptionType": "Abstract",
                    "lang": language.lower(),
                }
            )
    attributes: dict[str, Any] = {
        "doi": str(doi).lower(),
        "schemaVersion": "http://datacite.org/schema/kernel-4",
        "titles": titles,
        "creators": creators,
        "publisher": publisher_value,
        "publicationYear": publication_year,
        "types": {"resourceTypeGeneral": general},
        "subjects": [{"subject": value} for value in summary.keywords],
        "language": summary.language.lower(),
        "version": str(summary.version_number),
        "descriptions": descriptions,
    }
    if summary.license:
        attributes["rightsList"] = [{"rights": summary.license}]
    if summary.spatial_extent:
        min_x, min_y, max_x, max_y = summary.spatial_extent
        attributes["geoLocations"] = [
            {
                "geoLocationBox": {
                    "westBoundLongitude": min_x,
                    "southBoundLatitude": min_y,
                    "eastBoundLongitude": max_x,
                    "northBoundLatitude": max_y,
                }
            }
        ]
    temporal = _temporal_interval(summary.temporal_start, summary.temporal_end)
    if temporal:
        attributes["dates"] = [{"date": temporal, "dateType": "Coverage"}]
    related = [
        {
            "relatedIdentifier": f"urn:uuid:{relationship.target_resource_id}",
            "relatedIdentifierType": "URN",
            "relationType": "IsDerivedFrom",
        }
        for relationship in resource.relationships
        if relationship.source_resource_id == summary.resource_id
        and relationship.relation == "derived_from"
    ]
    if related:
        attributes["relatedIdentifiers"] = related
    funding = cast(list[dict[str, str]], catalog.get("funding", []))
    if funding:
        attributes["fundingReferences"] = funding
    elif "funding" in catalog or (imported_datacite and "fundingReferences" in datacite):
        attributes["fundingReferences"] = []
    registration_mapped: list[str] = []
    registration_losses: list[str] = []
    native_creators = [
        {"name": contact.get("name") or contact.get("organization")}
        for contact in catalog.get("contacts", [])
        if contact.get("role") in {"author", "creator", "principalInvestigator"}
    ]
    if native_creators and [entry["name"] for entry in native_creators] != [
        entry.get("name") or entry.get("creatorName") for entry in creators
    ]:
        attributes["creators"] = native_creators
        registration_losses.append("creators[retained-source-conflicts-with-native-creators]")
    _datacite_registration_fields(datacite, attributes, registration_mapped, registration_losses)
    _datacite_complete_registration_fields(
        datacite, attributes, registration_mapped, registration_losses
    )
    if (
        catalog_publisher
        and publisher_value != retained_publisher
        and retained_publisher is not None
    ):
        registration_losses.append("publisher[retained-source-conflicts-with-native-publisher]")
    result = {
        "target": "datacite_4_7",
        "targetVersion": "4.7",
        "mediaType": "application/vnd.api+json",
        "status": "mapped_with_explicit_losses",
        "document": {"data": {"id": str(doi).lower(), "type": "dois", "attributes": attributes}},
        "documentText": None,
        "report": {
            "mapped": [
                "doi",
                "title",
                "abstract",
                "language",
                "keywords",
                "license",
                "spatial_extent",
                "temporal_extent",
                "version_number",
                "created_at",
                "relationships.derived_from",
                "metadata_extensions.datacite/research/opengeo.contacts",
                *(["metadata_extensions.opengeo.funding"] if funding else []),
                *registration_mapped,
            ],
            "defaulted": (
                ["publicationYear=created_at.year"] if "publicationYear" not in datacite else []
            ),
            "multilingualLanguages": sorted({summary.language.lower(), *translations}),
            "preservedExtensions": sorted(resource.metadata_extensions),
            "unmapped": [
                *_iso_contact_unit_losses(catalog),
                "content",
                "provenance",
                *registration_losses,
                *(
                    ["metadata_extensions.opengeo.isoDistributionGroups"]
                    if catalog.get("isoDistributionGroups")
                    else []
                ),
                *(
                    f"metadata_extensions.opengeo.distributions[{index}].isoTransfer.offlineMedia"
                    for index, distribution in enumerate(catalog.get("distributions", []))
                    if distribution.get("isoTransfer", {}).get("offlineMedia")
                ),
                *(
                    ["metadata_extensions.opengeo.acquisition"]
                    if catalog.get("acquisition")
                    else []
                ),
                *(
                    ["metadata_extensions.opengeo.qualityReports"]
                    if catalog.get("qualityReports")
                    else []
                ),
            ],
            "conformanceClaimed": False,
        },
    }
    if (
        not attributes["creators"]
        or not attributes["publisher"]
        or len(canonical_metadata_json(result["report"])) > 16_384
        or len(canonical_metadata_json(result["document"])) > 49_152
    ):
        result.update(status="not_exportable_registration_limits", document=None)
        result["report"] = {
            "unmapped": ["registration values unsupported or conversion report exceeds16384bytes"],
            "preservedExtensions": sorted(resource.metadata_extensions),
            "conformanceClaimed": False,
        }
    return result


def _datacite_complete_registration_xml(
    root: ET.Element, attributes: dict[str, Any], namespace: str
) -> None:
    """Serialize clean registration values; validation and custody stay with the projector."""
    xml_lang = "{http://www.w3.org/XML/1998/namespace}lang"

    def tag(name: str) -> str:
        return f"{{{namespace}}}{name}"

    def child(parent: ET.Element, name: str, value: Any = None) -> ET.Element:
        element = ET.SubElement(parent, tag(name))
        if value is not None:
            element.text = str(value)
        return element

    def set_attributes(
        element: ET.Element, value: dict[str, Any], fields: tuple[tuple[str, str], ...]
    ) -> None:
        for source, target in fields:
            if source in value:
                element.set(target, str(value[source]))

    def title(parent: ET.Element, value: dict[str, Any]) -> None:
        element = child(parent, "title", value["title"])
        set_attributes(element, value, (("titleType", "titleType"), ("lang", xml_lang)))

    def limited_person(
        parent: ET.Element, value: dict[str, Any], contributor: bool = False
    ) -> None:
        element = child(parent, "contributor" if contributor else "creator")
        if contributor:
            element.set("contributorType", value["contributorType"])
        name = value.get("name", value.get("creatorName", value.get("contributorName")))
        name_element = child(element, "contributorName" if contributor else "creatorName", name)
        set_attributes(name_element, value, (("nameType", "nameType"), ("lang", xml_lang)))
        for field in ("givenName", "familyName"):
            if field in value:
                child(element, field, value[field])

    rebuilt = {
        "titles",
        "subjects",
        "dates",
        "rightsList",
        "descriptions",
        "geoLocations",
        "relatedIdentifiers",
        "relatedItems",
        "fundingReferences",
        "resourceType",
        "version",
    }
    for element in list(root):
        if element.tag in {tag(name) for name in rebuilt}:
            root.remove(element)

    if "titles" in attributes:
        titles = child(root, "titles")
        for value in attributes["titles"]:
            title(titles, value)
    if "subjects" in attributes:
        subjects = child(root, "subjects")
        for value in attributes["subjects"]:
            element = child(subjects, "subject", value["subject"])
            set_attributes(
                element,
                value,
                (
                    ("subjectScheme", "subjectScheme"),
                    ("schemeUri", "schemeURI"),
                    ("valueUri", "valueURI"),
                    ("classificationCode", "classificationCode"),
                    ("lang", xml_lang),
                ),
            )
    if "dates" in attributes:
        dates = child(root, "dates")
        for value in attributes["dates"]:
            element = child(dates, "date", value["date"])
            set_attributes(
                element, value, (("dateType", "dateType"), ("dateInformation", "dateInformation"))
            )
    if "rightsList" in attributes:
        rights = child(root, "rightsList")
        for value in attributes["rightsList"]:
            element = child(rights, "rights", value.get("rights"))
            set_attributes(
                element,
                value,
                (
                    ("rightsUri", "rightsURI"),
                    ("rightsIdentifier", "rightsIdentifier"),
                    ("rightsIdentifierScheme", "rightsIdentifierScheme"),
                    ("schemeUri", "schemeURI"),
                    ("lang", xml_lang),
                ),
            )
    if "descriptions" in attributes:
        descriptions = child(root, "descriptions")
        for value in attributes["descriptions"]:
            element = child(descriptions, "description", value["description"])
            set_attributes(
                element, value, (("descriptionType", "descriptionType"), ("lang", xml_lang))
            )
    resource_type = attributes["types"]
    element = child(root, "resourceType", resource_type.get("resourceType"))
    element.set("resourceTypeGeneral", resource_type["resourceTypeGeneral"])
    if "version" in attributes:
        child(root, "version", attributes["version"])
    if "relatedIdentifiers" in attributes:
        group = child(root, "relatedIdentifiers")
        for value in attributes["relatedIdentifiers"]:
            element = child(group, "relatedIdentifier", value["relatedIdentifier"])
            set_attributes(
                element,
                value,
                (
                    ("relatedIdentifierType", "relatedIdentifierType"),
                    ("relationType", "relationType"),
                    ("relatedMetadataScheme", "relatedMetadataScheme"),
                    ("schemeUri", "schemeURI"),
                    ("schemeType", "schemeType"),
                    ("resourceTypeGeneral", "resourceTypeGeneral"),
                    ("relationTypeInformation", "relationTypeInformation"),
                ),
            )

    def point(parent: ET.Element, name: str, value: dict[str, Any]) -> None:
        element = child(parent, name)
        for coordinate in ("pointLongitude", "pointLatitude"):
            child(element, coordinate, value[coordinate])

    if "geoLocations" in attributes:
        group = child(root, "geoLocations")
        for value in attributes["geoLocations"]:
            element = child(group, "geoLocation")
            if "geoLocationPlace" in value:
                child(element, "geoLocationPlace", value["geoLocationPlace"])
            if "geoLocationPoint" in value:
                point(element, "geoLocationPoint", value["geoLocationPoint"])
            if "geoLocationBox" in value:
                box = child(element, "geoLocationBox")
                for key in (
                    "westBoundLongitude",
                    "eastBoundLongitude",
                    "southBoundLatitude",
                    "northBoundLatitude",
                ):
                    child(box, key, value["geoLocationBox"][key])
            for polygon in value.get("geoLocationPolygon", []):
                ring = child(element, "geoLocationPolygon")
                for vertex in polygon.get("polygonPoint", polygon.get("polygonPoints", [])):
                    point(ring, "polygonPoint", vertex)
                if "inPolygonPoint" in polygon:
                    point(ring, "inPolygonPoint", polygon["inPolygonPoint"])
    if "relatedItems" in attributes:
        group = child(root, "relatedItems")
        for value in attributes["relatedItems"]:
            element = child(group, "relatedItem")
            set_attributes(
                element,
                value,
                (
                    ("relatedItemType", "relatedItemType"),
                    ("relationType", "relationType"),
                    ("relationTypeInformation", "relationTypeInformation"),
                ),
            )
            if "relatedItemIdentifier" in value:
                identifier = value["relatedItemIdentifier"]
                identifier_element = child(
                    element, "relatedItemIdentifier", identifier["relatedItemIdentifier"]
                )
                set_attributes(
                    identifier_element,
                    identifier,
                    (
                        ("relatedItemIdentifierType", "relatedItemIdentifierType"),
                        ("relatedMetadataScheme", "relatedMetadataScheme"),
                        ("schemeURI", "schemeURI"),
                        ("schemeType", "schemeType"),
                    ),
                )
            if "creators" in value:
                creators = child(element, "creators")
                for person in value["creators"]:
                    limited_person(creators, person)
            if "titles" in value:
                titles = child(element, "titles")
                for title_value in value["titles"]:
                    title(titles, title_value)
            for key in (
                "publicationYear",
                "volume",
                "issue",
                "number",
                "firstPage",
                "lastPage",
                "publisher",
                "edition",
            ):
                if key in value:
                    item = child(element, key, value[key])
                    if key == "number" and "numberType" in value:
                        item.set("numberType", value["numberType"])
            if "contributors" in value:
                contributors = child(element, "contributors")
                for person in value["contributors"]:
                    limited_person(contributors, person, True)
    if "fundingReferences" in attributes:
        group = child(root, "fundingReferences")
        for value in attributes["fundingReferences"]:
            element = child(group, "fundingReference")
            child(element, "funderName", value["funderName"])
            if "funderIdentifier" in value:
                identifier_element = child(element, "funderIdentifier", value["funderIdentifier"])
                set_attributes(
                    identifier_element,
                    value,
                    (("funderIdentifierType", "funderIdentifierType"), ("schemeUri", "schemeURI")),
                )
            if "awardNumber" in value:
                award = child(element, "awardNumber", value["awardNumber"])
                set_attributes(award, value, (("awardUri", "awardURI"),))
            if "awardTitle" in value:
                child(element, "awardTitle", value["awardTitle"])


def export_datacite_4_7_xml(resource: Any) -> dict[str, Any]:
    json_result = export_datacite_4_7(resource)
    if json_result["document"] is None:
        result = dict(json_result)
        result.update(
            {
                "target": "datacite_4_7_xml",
                "mediaType": "application/xml",
                "documentText": None,
            }
        )
        return result

    namespace = "http://datacite.org/schema/kernel-4"
    xsi = "http://www.w3.org/2001/XMLSchema-instance"
    xml = "http://www.w3.org/XML/1998/namespace"
    ET.register_namespace("", namespace)
    ET.register_namespace("xsi", xsi)

    def tag(name: str) -> str:
        return f"{{{namespace}}}{name}"

    def child(parent: ET.Element, name: str, text: Any | None = None) -> ET.Element:
        element = ET.SubElement(parent, tag(name))
        if text is not None:
            element.text = str(text)
        return element

    document = cast(dict[str, Any], json_result["document"])
    data = cast(dict[str, Any], document["data"])
    attributes = cast(dict[str, Any], data["attributes"])
    root = ET.Element(tag("resource"))
    root.set(
        f"{{{xsi}}}schemaLocation",
        f"{namespace} https://schema.datacite.org/meta/kernel-4/metadata.xsd",
    )
    identifier = child(root, "identifier", data["id"])
    identifier.set("identifierType", "DOI")

    creators_element = child(root, "creators")
    for creator in cast(list[dict[str, Any]], attributes["creators"]):
        creator_element = child(creators_element, "creator")
        name = creator.get("name") or creator.get("creatorName")
        creator_name = child(creator_element, "creatorName", name)
        if isinstance(creator.get("nameType"), str):
            creator_name.set("nameType", creator["nameType"])
        if isinstance(creator.get("lang"), str):
            creator_name.set(f"{{{xml}}}lang", creator["lang"])
        for source_name, target_name in (
            ("givenName", "givenName"),
            ("familyName", "familyName"),
        ):
            if isinstance(creator.get(source_name), str):
                child(creator_element, target_name, creator[source_name])

        for value in creator.get("nameIdentifiers", []):
            element = child(creator_element, "nameIdentifier", value["nameIdentifier"])
            element.set("nameIdentifierScheme", value["nameIdentifierScheme"])
            if "schemeUri" in value:
                element.set("schemeURI", value["schemeUri"])
        for value in creator.get("affiliation", []):
            element = child(
                creator_element, "affiliation", value if isinstance(value, str) else value["name"]
            )
            if isinstance(value, dict):
                for key, target in (
                    ("affiliationIdentifier", "affiliationIdentifier"),
                    ("affiliationIdentifierScheme", "affiliationIdentifierScheme"),
                    ("schemeUri", "schemeURI"),
                ):
                    if key in value:
                        element.set(target, value[key])

    publisher_value = attributes["publisher"]
    publisher_name = (
        publisher_value.get("name") if isinstance(publisher_value, dict) else publisher_value
    )
    publisher = child(root, "publisher", publisher_name)
    if isinstance(publisher_value, dict):
        publisher_attributes = {
            "publisherIdentifier": "publisherIdentifier",
            "publisherIdentifierScheme": "publisherIdentifierScheme",
            "schemeUri": "schemeURI",
            "lang": f"{{{xml}}}lang",
        }
        for source_name, target_name in publisher_attributes.items():
            if isinstance(publisher_value.get(source_name), str):
                publisher.set(target_name, publisher_value[source_name])
    child(root, "publicationYear", attributes["publicationYear"])

    if attributes.get("contributors"):
        contributors_element = child(root, "contributors")
        for value in attributes["contributors"]:
            element = child(contributors_element, "contributor")
            element.set("contributorType", value["contributorType"])
            name = child(element, "contributorName", value.get("name") or value.get("creatorName"))
            if "nameType" in value:
                name.set("nameType", value["nameType"])
            if "lang" in value:
                name.set(f"{{{xml}}}lang", value["lang"])
            for key in ("givenName", "familyName"):
                if key in value:
                    child(element, key, value[key])
            for identifier_value in value.get("nameIdentifiers", []):
                identifier_element = child(
                    element, "nameIdentifier", identifier_value["nameIdentifier"]
                )
                identifier_element.set(
                    "nameIdentifierScheme", identifier_value["nameIdentifierScheme"]
                )
                if "schemeUri" in identifier_value:
                    identifier_element.set("schemeURI", identifier_value["schemeUri"])
            for affiliation_value in value.get("affiliation", []):
                affiliation = child(
                    element,
                    "affiliation",
                    affiliation_value
                    if isinstance(affiliation_value, str)
                    else affiliation_value["name"],
                )
                if isinstance(affiliation_value, dict):
                    for key, target in (
                        ("affiliationIdentifier", "affiliationIdentifier"),
                        ("affiliationIdentifierScheme", "affiliationIdentifierScheme"),
                        ("schemeUri", "schemeURI"),
                    ):
                        if key in affiliation_value:
                            affiliation.set(target, affiliation_value[key])

    if attributes.get("language"):
        child(root, "language", attributes["language"])

    if attributes.get("alternateIdentifiers"):
        alternate_element = child(root, "alternateIdentifiers")
        for value in attributes["alternateIdentifiers"]:
            element = child(alternate_element, "alternateIdentifier", value["alternateIdentifier"])
            element.set("alternateIdentifierType", value["alternateIdentifierType"])

    for field, singular in (("sizes", "size"), ("formats", "format")):
        if attributes.get(field):
            group = child(root, field)
            for value in attributes[field]:
                child(group, singular, value)

    _datacite_complete_registration_xml(root, attributes, namespace)
    document_text = ET.tostring(root, encoding="unicode", xml_declaration=True)
    result = dict(json_result)
    result.update(
        {
            "target": "datacite_4_7_xml",
            "mediaType": "application/xml",
            "document": None,
            "documentText": document_text,
        }
    )
    report = dict(cast(dict[str, Any], json_result["report"]))
    report["normativeRepresentation"] = "DataCite Metadata Schema 4.7 XML"
    report["schemaValidated"] = False
    result["report"] = report
    if len(document_text.encode("utf-8")) > 49_152 or len(canonical_metadata_json(report)) > 16_384:
        result.update(status="not_exportable_registration_limits", documentText=None)
        result["report"] = {
            "unmapped": [
                "DataCite export exceeds 49152 UTF-8 bytes or its report exceeds 16384 bytes"
            ],
            "preservedExtensions": sorted(resource.metadata_extensions),
            "conformanceClaimed": False,
        }
    return result


def export_geodcat_ap_3_1(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    if summary.kind not in {"dataset", "service"}:
        return _not_applicable_export("geodcat_ap_3_1", "3.1.0", "application/ld+json", resource)
    if summary.abstract is None:
        result = _not_applicable_export("geodcat_ap_3_1", "3.1.0", "application/ld+json", resource)
        result["status"] = "not_exportable_missing_required_metadata"
        result["report"]["missingRequired"] = ["abstract"]
        result["report"]["conformanceClaimed"] = False
        return result
    result = export_dcat_3(resource)
    document = cast(dict[str, Any], result["document"])
    context = cast(dict[str, Any], document["@context"])
    context["geodcatap"] = "http://data.europa.eu/930/"
    context["dqv"] = "http://www.w3.org/ns/dqv#"
    context["foaf"] = "http://xmlns.com/foaf/0.1/"
    context["skos"] = "http://www.w3.org/2004/02/skos/core#"
    context["rdf"] = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

    def typed_iri(value: Any, class_name: str, *, label: bool = False) -> dict[str, Any] | None:
        iri = value.get("@id") if isinstance(value, dict) else value
        if not isinstance(iri, str):
            return None
        result_value: dict[str, Any] = {"@id": iri, "@type": class_name}
        if label:
            source_label = value.get("skos:prefLabel") if isinstance(value, dict) else None
            result_value["skos:prefLabel"] = source_label or {
                "@value": iri.rstrip("/").rsplit("/", 1)[-1],
                "@language": "en",
            }
        return result_value

    document["dct:language"] = [
        {"@id": f"urn:ietf:bcp47:{language}", "@type": "dct:LinguisticSystem"}
        for language in sorted({summary.language.lower(), *getattr(resource, "translations", {})})
    ]
    document["geodcatap:resourceType"] = typed_iri(
        (
            "http://inspire.ec.europa.eu/metadata-codelist/ResourceType/dataset"
            if summary.kind == "dataset"
            else "http://inspire.ec.europa.eu/metadata-codelist/ResourceType/service"
        ),
        "skos:Concept",
        label=True,
    )
    spatial = document.get("dct:spatial")
    if isinstance(spatial, dict) and isinstance(spatial.get("locn:geometry"), dict):
        spatial["locn:geometry"] = {
            "@type": "locn:Geometry",
            "rdf:value": spatial["locn:geometry"],
        }
    if "dct:rights" in document:
        rights_values = document["dct:rights"]
        if not isinstance(rights_values, list):
            rights_values = [rights_values]
        document["dct:rights"] = [
            {"@type": "dct:RightsStatement", "rdfs:label": value} for value in rights_values
        ]
        context["rdfs"] = "http://www.w3.org/2000/01/rdf-schema#"
    profile = resource.metadata_extensions.get("geodcat_ap", {})
    if isinstance(profile, dict):
        typed_iris = {
            "dct:conformsTo": ("dct:Standard", False),
            "dcat:theme": ("skos:Concept", True),
            "geodcatap:topicCategory": ("skos:Concept", True),
            "geodcatap:referenceSystem": ("skos:Concept", True),
        }
        for field, (class_name, label) in typed_iris.items():
            value = profile.get(field)
            if value is not None:
                values = value if isinstance(value, list) else [value]
                document[field] = [
                    result_value
                    for item in values
                    if (result_value := typed_iri(item, class_name, label=label)) is not None
                ]
        if "dcat:spatialResolutionInMeters" in profile:
            document["dcat:spatialResolutionInMeters"] = {
                "@value": str(profile["dcat:spatialResolutionInMeters"]),
                "@type": "xsd:decimal",
            }
    catalog = catalog_metadata(resource.metadata_extensions)
    reference_systems = cast(list[dict[str, str]], catalog.get("referenceSystems", []))
    if reference_systems:
        existing = document.get("geodcatap:referenceSystem", [])
        existing_values = existing if isinstance(existing, list) else [existing]
        candidates = [
            *existing_values,
            *[
                {
                    "@id": value.get("uri", f"urn:ogc:def:crs:{value['identifier']}"),
                    "@type": "skos:Concept",
                    "skos:prefLabel": {
                        "@value": value["identifier"],
                        "@language": "en",
                    },
                }
                for value in reference_systems
            ],
        ]
        seen_reference_iris: set[str] = set()
        unique_references: list[Any] = []
        for value in candidates:
            iri = value.get("@id") if isinstance(value, dict) else None
            if isinstance(iri, str):
                if iri in seen_reference_iris:
                    continue
                seen_reference_iris.add(iri)
            unique_references.append(value)
        document["geodcatap:referenceSystem"] = unique_references
    _geodcat_catalog_shapes(document)
    result.update(
        {
            "target": "geodcat_ap_3_1",
            "targetVersion": "3.1.0",
            "status": "mapped_with_explicit_losses",
            "documentText": None,
        }
    )
    report = cast(dict[str, Any], result["report"])
    report["mapped"] = [
        *cast(list[str], report["mapped"]),
        "resource_kind",
        *(["metadata_extensions.opengeo.referenceSystems"] if reference_systems else []),
    ]
    report["unmapped"] = [
        *[
            value
            for value in cast(list[str], report["unmapped"])
            if value != "metadata_extensions.opengeo.referenceSystems"
        ],
        "mandatory/recommended controlled vocabularies not present in canonical metadata",
    ]
    report["conformanceClaimed"] = False
    return result


def export_iso_19115_3(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    native_translations = getattr(resource, "translations", {})
    translations = {
        language: value
        for language, value in native_translations.items()
        if re.fullmatch(r"[A-Za-z]{2,3}", language)
    }
    unmapped_translations = [
        f"translations.{language}"
        for language in sorted(native_translations)
        if language not in translations
    ]
    mapped_translations = (
        [f"translations.{language}" for language in sorted(translations)]
        if unmapped_translations
        else (["translations"] if translations else [])
    )
    if summary.kind not in {"dataset", "service"}:
        return _not_applicable_export(
            "iso_19115_3", "ISO 19115-3:2023", "application/xml", resource
        )
    primary_locale = _iso_primary_locale(summary.language)
    catalog = catalog_metadata(resource.metadata_extensions)
    research = resource.metadata_extensions.get("research", {})
    contacts = catalog.get("contacts")
    if not isinstance(contacts, list) or not contacts:
        contacts = research.get("contacts", []) if isinstance(research, dict) else []
    contact_name: str | None = None
    contact_defaulted = False
    if isinstance(contacts, list):
        for value in contacts:
            if isinstance(value, dict):
                candidate = value.get("organization") or value.get("name")
                if isinstance(candidate, str) and candidate.strip():
                    contact_name = candidate.strip()
                    break
    if contact_name is None and summary.attribution:
        contact_name = summary.attribution
        contact_defaulted = True
    missing = [
        name
        for name, value in (("abstract", summary.abstract), ("contact", contact_name))
        if not value
    ]
    if primary_locale is None:
        missing.append("language")
    if missing:
        result = _not_applicable_export(
            "iso_19115_3", "ISO 19115-3:2023", "application/xml", resource
        )
        result["status"] = "not_exportable_missing_required_metadata"
        result["report"]["missingRequired"] = missing
        if primary_locale is None:
            result["report"]["unmapped"] = ["language"]
            result["report"]["unmappedValues"] = {"language": summary.language}
            result["report"]["warnings"] = [
                "ISO primary locale requires a plain language or a language with a registered "
                "alpha-2 country; script, numeric-region and variant subtags are not mapped. "
                "The exact native language tag is unchanged."
            ]
        result["report"]["schemaValidated"] = False
        result["report"]["schematronValidated"] = False
        result["report"]["conformanceClaimed"] = False
        return result
    assert primary_locale is not None
    primary_language, primary_country = primary_locale
    namespaces = {
        "mdb": "http://standards.iso.org/iso/19115/-3/mdb/2.0",
        "mcc": "http://standards.iso.org/iso/19115/-3/mcc/1.0",
        "mri": "http://standards.iso.org/iso/19115/-3/mri/1.0",
        "srv": "http://standards.iso.org/iso/19115/-3/srv/2.0",
        "cit": "http://standards.iso.org/iso/19115/-3/cit/2.0",
        "lan": "http://standards.iso.org/iso/19115/-3/lan/1.0",
        "gex": "http://standards.iso.org/iso/19115/-3/gex/1.0",
        "mco": "http://standards.iso.org/iso/19115/-3/mco/1.0",
        "mrs": "http://standards.iso.org/iso/19115/-3/mrs/1.0",
        "mrd": "http://standards.iso.org/iso/19115/-3/mrd/1.0",
        "mrl": "http://standards.iso.org/iso/19115/-3/mrl/2.0",
        "mac": "http://standards.iso.org/iso/19115/-3/mac/2.0",
        "mdq": "http://standards.iso.org/iso/19157/-2/mdq/1.0",
        "gco": "http://standards.iso.org/iso/19115/-3/gco/1.0",
        "gml": "http://www.opengis.net/gml/3.2",
        "xlink": "http://www.w3.org/1999/xlink",
        "xsi": "http://www.w3.org/2001/XMLSchema-instance",
    }
    for prefix, uri in namespaces.items():
        ET.register_namespace(prefix, uri)

    def tag(prefix: str, name: str) -> str:
        return f"{{{namespaces[prefix]}}}{name}"

    def child(parent: ET.Element, prefix: str, name: str, text: str | None = None) -> ET.Element:
        element = ET.SubElement(parent, tag(prefix, name))
        if text is not None:
            element.text = text
        return element

    def localized_text(
        parent: ET.Element, prefix: str, name: str, text: str | None, field: str
    ) -> ET.Element:
        property_value = child(parent, prefix, name)
        if text is not None:
            child(property_value, "gco", "CharacterString", text)
        localized = [
            (language, value[field])
            for language, value in sorted(translations.items())
            if value.get(field) is not None
        ]
        if localized:
            property_value.set(tag("xsi", "type"), "lan:PT_FreeText_PropertyType")
            free_text = child(property_value, "lan", "PT_FreeText")
            for language, value in localized:
                group = child(free_text, "lan", "textGroup")
                localized_value = child(group, "lan", "LocalisedCharacterString", value)
                localized_value.set("locale", f"#locale-{language}")
        return property_value

    root = ET.Element(tag("mdb", "MD_Metadata"))
    metadata_identifier = child(root, "mdb", "metadataIdentifier")
    identifier = child(metadata_identifier, "mcc", "MD_Identifier")
    child(child(identifier, "mcc", "code"), "gco", "CharacterString", str(summary.resource_id))
    default_locale = child(root, "mdb", "defaultLocale")
    locale = child(default_locale, "lan", "PT_Locale")
    language = child(locale, "lan", "language")
    language_code = child(language, "lan", "LanguageCode", primary_language)
    language_code.set(
        "codeList", "https://schemas.isotc211.org/19115/resources/Codelist/lan/LanguageCode.xml"
    )
    language_code.set("codeListValue", primary_language)
    if primary_country is not None:
        country = child(locale, "lan", "country")
        country_code = child(country, "lan", "CountryCode", primary_country)
        country_code.set("codeList", _ISO_COUNTRY_CODELIST)
        country_code.set("codeListValue", primary_country)
    character_encoding = child(locale, "lan", "characterEncoding")
    character_encoding_code = child(character_encoding, "lan", "MD_CharacterSetCode", "utf8")
    character_encoding_code.set(
        "codeList",
        "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_CharacterSetCode",
    )
    character_encoding_code.set("codeListValue", "utf8")
    contact_records = [value for value in contacts if isinstance(value, dict)]
    if not contact_records:
        contact_records = [{"organization": contact_name}]
    for value in contact_records:
        contact = child(root, "mdb", "contact")
        responsibility = child(contact, "cit", "CI_Responsibility")
        role_value = value.get("role", "pointOfContact")
        role = child(responsibility, "cit", "role")
        role_code = child(role, "cit", "CI_RoleCode", role_value)
        role_code.set(
            "codeList",
            "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_RoleCode",
        )
        role_code.set("codeListValue", role_value)
        party = child(responsibility, "cit", "party")
        party_type = "CI_Organisation" if value.get("organization") else "CI_Individual"
        party_value = child(party, "cit", party_type)
        child(
            child(party_value, "cit", "name"),
            "gco",
            "CharacterString",
            value.get("organization") or value.get("name") or contact_name,
        )
        if value.get("email"):
            contact_info = child(party_value, "cit", "contactInfo")
            contact_value = child(contact_info, "cit", "CI_Contact")
            address = child(contact_value, "cit", "address")
            address_value = child(address, "cit", "CI_Address")
            email = child(address_value, "cit", "electronicMailAddress")
            child(email, "gco", "CharacterString", value["email"])
    date_info = child(root, "mdb", "dateInfo")
    date = child(date_info, "cit", "CI_Date")
    child(child(date, "cit", "date"), "gco", "DateTime", summary.updated_at.isoformat())
    date_type = child(date, "cit", "dateType")
    date_code = child(date_type, "cit", "CI_DateTypeCode", "revision")
    date_code.set(
        "codeList",
        "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_DateTypeCode",
    )
    date_code.set("codeListValue", "revision")
    for translated_language in sorted(translations):
        other_locale = child(root, "mdb", "otherLocale")
        locale = child(other_locale, "lan", "PT_Locale")
        locale.set("id", f"locale-{translated_language}")
        language = child(locale, "lan", "language")
        code = child(language, "lan", "LanguageCode", translated_language)
        code.set(
            "codeList", "https://schemas.isotc211.org/19115/resources/Codelist/lan/LanguageCode.xml"
        )
        code.set("codeListValue", translated_language)
        encoding = child(locale, "lan", "characterEncoding")
        code = child(encoding, "lan", "MD_CharacterSetCode", "utf8")
        code.set(
            "codeList",
            "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_CharacterSetCode",
        )
        code.set("codeListValue", "utf8")
    reference_systems = cast(list[dict[str, str]], catalog.get("referenceSystems", []))
    for value in reference_systems:
        reference_info = child(root, "mdb", "referenceSystemInfo")
        reference_system = child(reference_info, "mrs", "MD_ReferenceSystem")
        reference_identifier = child(reference_system, "mrs", "referenceSystemIdentifier")
        reference_value = child(reference_identifier, "mcc", "MD_Identifier")
        child(
            child(reference_value, "mcc", "code"),
            "gco",
            "CharacterString",
            value["identifier"],
        )
        if value.get("uri"):
            child(
                child(reference_value, "mcc", "codeSpace"),
                "gco",
                "CharacterString",
                value["uri"],
            )
    info = child(root, "mdb", "identificationInfo")
    identification = child(
        info,
        "mri" if summary.kind == "dataset" else "srv",
        "MD_DataIdentification" if summary.kind == "dataset" else "SV_ServiceIdentification",
    )
    citation = child(identification, "mri", "citation")
    citation_value = child(citation, "cit", "CI_Citation")
    localized_text(citation_value, "cit", "title", summary.title, "title")
    localized_text(identification, "mri", "abstract", summary.abstract, "abstract")
    if summary.attribution or any(value.get("attribution") for value in translations.values()):
        localized_text(identification, "mri", "credit", summary.attribution, "attribution")
    if summary.spatial_extent or summary.temporal_start or summary.temporal_end:
        extent = child(identification, "mri", "extent")
        extent_value = child(extent, "gex", "EX_Extent")
        if summary.spatial_extent:
            min_x, min_y, max_x, max_y = summary.spatial_extent
            geographic = child(extent_value, "gex", "geographicElement")
            box = child(geographic, "gex", "EX_GeographicBoundingBox")
            for name, value in (
                ("westBoundLongitude", min_x),
                ("eastBoundLongitude", max_x),
                ("southBoundLatitude", min_y),
                ("northBoundLatitude", max_y),
            ):
                child(child(box, "gex", name), "gco", "Decimal", str(value))
        if summary.temporal_start or summary.temporal_end:
            temporal = child(extent_value, "gex", "temporalElement")
            temporal_extent = child(temporal, "gex", "EX_TemporalExtent")
            period_property = child(temporal_extent, "gex", "extent")
            period = child(period_property, "gml", "TimePeriod")
            period.set(tag("gml", "id"), f"period-{summary.resource_id}")
            begin = child(
                period,
                "gml",
                "beginPosition",
                summary.temporal_start.isoformat() if summary.temporal_start else None,
            )
            if summary.temporal_start is None:
                begin.set("indeterminatePosition", "unknown")
            end = child(
                period,
                "gml",
                "endPosition",
                summary.temporal_end.isoformat() if summary.temporal_end else None,
            )
            if summary.temporal_end is None:
                end.set("indeterminatePosition", "unknown")
    if summary.keywords or any(value.get("keywords") for value in translations.values()):
        descriptive = child(identification, "mri", "descriptiveKeywords")
        keyword_group = child(descriptive, "mri", "MD_Keywords")
        for keyword in summary.keywords:
            child(child(keyword_group, "mri", "keyword"), "gco", "CharacterString", keyword)
        # Native translations retain vocabulary lists, not term-to-term alignments.
        for translated_language, value in sorted(translations.items()):
            for keyword in value.get("keywords", []):
                property_value = child(keyword_group, "mri", "keyword")
                property_value.set(tag("xsi", "type"), "lan:PT_FreeText_PropertyType")
                free_text = child(property_value, "lan", "PT_FreeText")
                group = child(free_text, "lan", "textGroup")
                localized_value = child(group, "lan", "LocalisedCharacterString", keyword)
                localized_value.set("locale", f"#locale-{translated_language}")
    if summary.license:
        constraints = child(identification, "mri", "resourceConstraints")
        legal = child(constraints, "mco", "MD_LegalConstraints")
        child(child(legal, "mco", "useLimitation"), "gco", "CharacterString", summary.license)
    if summary.kind == "service":
        service_type = child(identification, "srv", "serviceType")
        scoped_name = child(service_type, "gco", "ScopedName", "service")
        scoped_name.set("codeSpace", "https://schemas.isotc211.org/19115/-3/srv/2.0")
    distributions = cast(list[dict[str, Any]], catalog.get("distributions", []))
    offline_media_present = any(
        value.get("isoTransfer", {}).get("offlineMedia") for value in distributions
    )
    distribution_mapped: list[str] = []
    distribution_unmapped: list[str] = []
    distribution_blocks: list[tuple[ET.Element, ET.Element, str]] = []
    distribution_wrappers: dict[ET.Element, ET.Element] = {}

    def distribution_text(
        parent: ET.Element,
        prefix: str,
        name: str,
        value: str,
        path: str,
        xml_type: str = "CharacterString",
        *,
        mapped: list[str] = distribution_mapped,
        unmapped: list[str] = distribution_unmapped,
    ) -> bool:
        if not _iso_quality_unit_label_supported(value):
            unmapped.append(path)
            return False
        child(child(parent, prefix, name), "gco", xml_type, value)
        mapped.append(path)
        return True

    def distribution_citation(
        parent: ET.Element,
        value: dict[str, Any],
        path: str,
        *,
        prefix: str = "mrd",
        name: str = "formatSpecificationCitation",
        mapped: list[str] = distribution_mapped,
        unmapped: list[str] = distribution_unmapped,
    ) -> bool:
        if not _iso_quality_unit_label_supported(value["title"]):
            unmapped.append(path)
            unmapped.extend(f"{path}.{field}" for field in ("isbn", "issn") if field in value)
            return False
        citation = child(child(parent, prefix, name), "cit", "CI_Citation")
        distribution_text(
            citation,
            "cit",
            "title",
            value["title"],
            f"{path}.title",
            mapped=mapped,
            unmapped=unmapped,
        )
        for index, alternate in enumerate(value.get("alternateTitles", [])):
            distribution_text(
                citation,
                "cit",
                "alternateTitle",
                alternate,
                f"{path}.alternateTitles[{index}]",
                mapped=mapped,
                unmapped=unmapped,
            )
        for index, date_value in enumerate(value.get("dates", [])):
            date_path = f"{path}.dates[{index}]"
            if not all(
                _iso_quality_unit_label_supported(date_value[key]) for key in ("date", "dateType")
            ):
                unmapped.append(date_path)
                continue
            date = child(child(citation, "cit", "date"), "cit", "CI_Date")
            child(child(date, "cit", "date"), "gco", "Date", date_value["date"])
            code = child(
                child(date, "cit", "dateType"), "cit", "CI_DateTypeCode", date_value["dateType"]
            )
            code.set(
                "codeList",
                "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_DateTypeCode",
            )
            code.set("codeListValue", date_value["dateType"])
            mapped.append(date_path)
        for field, xml_type in (("edition", "CharacterString"), ("editionDate", "DateTime")):
            if field in value:
                distribution_text(
                    citation,
                    "cit",
                    field,
                    value[field],
                    f"{path}.{field}",
                    xml_type,
                    mapped=mapped,
                    unmapped=unmapped,
                )
        for index, identifier_value in enumerate(value.get("identifiers", [])):
            identifier_path = f"{path}.identifiers[{index}]"
            if not all(_iso_quality_unit_label_supported(v) for v in identifier_value.values()):
                unmapped.append(identifier_path)
                continue
            identifier = child(child(citation, "cit", "identifier"), "mcc", "MD_Identifier")
            child(
                child(identifier, "mcc", "code"), "gco", "CharacterString", identifier_value["code"]
            )
            if "codeSpace" in identifier_value:
                child(
                    child(identifier, "mcc", "codeSpace"),
                    "gco",
                    "CharacterString",
                    identifier_value["codeSpace"],
                )
            mapped.append(identifier_path)
        for field, name in (("isbn", "ISBN"), ("issn", "ISSN")):
            if field in value:
                distribution_text(
                    citation,
                    "cit",
                    name,
                    value[field],
                    f"{path}.{field}",
                    mapped=mapped,
                    unmapped=unmapped,
                )
        return True

    def distribution_medium_fields(
        medium_element: ET.Element, medium_value: dict[str, Any], medium_path: str
    ) -> None:
        # The pinned MD_Medium sequence uses a citation, not MD_MediumNameCode.
        if "name" in medium_value:
            distribution_citation(
                medium_element,
                medium_value["name"],
                f"{medium_path}.name",
                name="name",
            )
        for medium_field, medium_xml_type in (
            ("density", "Real"),
            ("densityUnits", "CharacterString"),
            ("volumes", "Integer"),
        ):
            if medium_field in medium_value:
                # Density is already a validated finite lexical xs:double.
                # Only the native integer volume count needs string rendering.
                medium_text = medium_value[medium_field]
                if medium_field == "volumes":
                    medium_text = str(medium_text)
                distribution_text(
                    medium_element,
                    "mrd",
                    medium_field,
                    medium_text,
                    f"{medium_path}.{medium_field}",
                    medium_xml_type,
                )
        for medium_format_index, medium_format in enumerate(medium_value.get("mediumFormats", [])):
            medium_format_path = f"{medium_path}.mediumFormats[{medium_format_index}]"
            if not _iso_quality_unit_label_supported(medium_format) or any(
                character in medium_format for character in "\t\n"
            ):
                distribution_unmapped.append(medium_format_path)
                continue
            medium_format_code = child(
                child(medium_element, "mrd", "mediumFormat"),
                "mrd",
                "MD_MediumFormatCode",
                medium_format,
            )
            medium_format_code.set(
                "codeList",
                "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_MediumFormatCode",
            )
            medium_format_code.set("codeListValue", medium_format)
            distribution_mapped.append(medium_format_path)
        if "mediumNote" in medium_value:
            distribution_text(
                medium_element,
                "mrd",
                "mediumNote",
                medium_value["mediumNote"],
                f"{medium_path}.mediumNote",
            )
        if "identifier" in medium_value:
            medium_identifier_value = medium_value["identifier"]
            medium_identifier_path = f"{medium_path}.identifier"
            if not _iso_quality_unit_label_supported(medium_identifier_value["code"]):
                distribution_unmapped.append(medium_identifier_path)
            else:
                medium_identifier = child(
                    child(medium_element, "mrd", "identifier"),
                    "mcc",
                    "MD_Identifier",
                )
                for identifier_field in ("code", "codeSpace"):
                    if identifier_field in medium_identifier_value:
                        distribution_text(
                            medium_identifier,
                            "mcc",
                            identifier_field,
                            medium_identifier_value[identifier_field],
                            f"{medium_identifier_path}.{identifier_field}",
                        )

    def distribution_online_fields(
        parent: ET.Element,
        record: dict[str, Any],
        online_path: str,
        *,
        prefix: str = "mrd",
        name: str = "onLine",
    ) -> None:
        online = child(child(parent, prefix, name), "cit", "CI_OnlineResource")
        for field in ("linkage", "protocol", "applicationProfile", "name", "description"):
            if field in record:
                distribution_text(online, "cit", field, record[field], f"{online_path}.{field}")
        if "function" in record:
            function_value = record["function"]
            if _iso_quality_unit_label_supported(function_value) and not any(
                c in function_value for c in "\t\n"
            ):
                function_code = child(
                    child(online, "cit", "function"),
                    "cit",
                    "CI_OnLineFunctionCode",
                    function_value,
                )
                function_code.set(
                    "codeList",
                    "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_OnLineFunctionCode",
                )
                function_code.set("codeListValue", function_value)
                distribution_mapped.append(f"{online_path}.function")
            else:
                distribution_unmapped.append(f"{online_path}.function")
        if "protocolRequest" in record:
            distribution_text(
                online,
                "cit",
                "protocolRequest",
                record["protocolRequest"],
                f"{online_path}.protocolRequest",
            )

    def distribution_format_fields(element: ET.Element, record: dict[str, Any], path: str) -> bool:
        if not distribution_citation(element, record["citation"], f"{path}.citation"):
            return False
        for field in ("amendmentNumber", "fileDecompressionTechnique"):
            if field in record:
                distribution_text(element, "mrd", field, record[field], f"{path}.{field}")
        return True

    if distributions:
        for distribution_index, value in enumerate(distributions):
            # Native legacy records are independent; preserve one DTO owner per record.
            distribution_info = child(root, "mdb", "distributionInfo")
            distribution_value = child(distribution_info, "mrd", "MD_Distribution")
            distribution_wrappers[distribution_value] = distribution_info
            path = f"metadata_extensions.opengeo.distributions[{distribution_index}]"
            context = cast(dict[str, Any], value.get("isoTransfer", {}))
            bindings = cast(dict[str, int], context.get("projections", {}))
            online_values: list[dict[str, Any] | None] = deepcopy(
                context.get("onlineResources", [])
            )
            format_values: list[dict[str, Any] | None] = deepcopy(context.get("formats", []))
            for field in ("accessUrl", "downloadUrl"):
                function = "information" if field == "accessUrl" else "download"
                index = bindings.get(field)
                if index is not None:
                    record = online_values[index]
                    if record is not None:
                        if field in value:
                            record["linkage"] = value[field]
                        else:
                            online_values[index] = None
                            distribution_unmapped.append(
                                f"{path}.isoTransfer.onlineResources[{index}][native-clear]"
                            )
                elif field in value:
                    record = {"linkage": value[field], "function": function}
                    if "title" in value:
                        record["name"] = value["title"]
                    if not any(
                        existing is not None
                        and all(
                            existing.get(key) == record.get(key)
                            for key in ("linkage", "function", "name")
                        )
                        for existing in online_values
                    ):
                        online_values.append(record)
            title_index = bindings.get("title")
            if title_index is not None and online_values[title_index] is not None:
                title_record = cast(dict[str, Any], online_values[title_index])
                if "title" in value:
                    title_record["name"] = value["title"]
                else:
                    title_record.pop("name", None)
            format_index = bindings.get("format")
            if format_index is not None:
                format_record = format_values[format_index]
                if format_record is not None:
                    if "format" in value:
                        format_record["citation"]["title"] = value["format"]
                    else:
                        format_values[format_index] = None
                        distribution_unmapped.append(
                            f"{path}.isoTransfer.formats[{format_index}][native-clear]"
                        )
            elif "format" in value:
                record = {"citation": {"title": value["format"]}}
                if not any(
                    existing is not None and existing["citation"]["title"] == value["format"]
                    for existing in format_values
                ):
                    format_values.append(record)
            transfer_options = child(distribution_value, "mrd", "transferOptions")
            transfer = child(transfer_options, "mrd", "MD_DigitalTransferOptions")
            distribution_blocks.append((distribution_value, transfer_options, path))
            for field, xml_name, xml_type in (
                ("unitsOfDistribution", "unitsOfDistribution", "CharacterString"),
                ("transferSizeMegabytes", "transferSize", "Real"),
            ):
                if field in context:
                    distribution_text(
                        transfer,
                        "mrd",
                        xml_name,
                        str(context[field]),
                        f"{path}.isoTransfer.{field}",
                        xml_type,
                    )
            for online_index, record in enumerate(online_values):
                online_mapped_start = len(distribution_mapped)
                online_unmapped_start = len(distribution_unmapped)
                if record is None:
                    continue
                online_path = f"{path}.isoTransfer.onlineResources[{online_index}]"
                if not _iso_quality_unit_label_supported(record["linkage"]):
                    if online_index < len(context.get("onlineResources", [])):
                        distribution_unmapped.append(online_path)
                    continue
                distribution_online_fields(transfer, record, online_path)
                if online_index >= len(context.get("onlineResources", [])):
                    del distribution_mapped[online_mapped_start:]
                    del distribution_unmapped[online_unmapped_start:]
            for medium_index, medium_value in enumerate(context.get("offlineMedia", [])):
                medium_path = f"{path}.isoTransfer.offlineMedia[{medium_index}]"
                medium_property = child(transfer, "mrd", "offLine")
                medium_element = child(medium_property, "mrd", "MD_Medium")
                distribution_medium_fields(medium_element, medium_value, medium_path)
                if not len(medium_element):
                    transfer.remove(medium_property)
                    distribution_unmapped.append(medium_path)
            if "transferFrequency" in context:
                distribution_text(
                    transfer,
                    "mrd",
                    "transferFrequency",
                    context["transferFrequency"],
                    f"{path}.isoTransfer.transferFrequency",
                    "TM_PeriodDuration",
                )
            for format_record_index, record in enumerate(format_values):
                format_mapped_start = len(distribution_mapped)
                format_unmapped_start = len(distribution_unmapped)
                if record is None:
                    continue
                format_path = f"{path}.isoTransfer.formats[{format_record_index}]"
                format_property = child(transfer, "mrd", "distributionFormat")
                format_element = child(format_property, "mrd", "MD_Format")
                if not distribution_format_fields(format_element, record, format_path):
                    transfer.remove(format_property)
                    if format_record_index < len(context.get("formats", [])):
                        distribution_unmapped.append(format_path)
                    else:
                        del distribution_unmapped[format_unmapped_start:]
                    continue
                if format_record_index >= len(context.get("formats", [])):
                    del distribution_mapped[format_mapped_start:]
                    del distribution_unmapped[format_unmapped_start:]
            for field in ("accessUrl", "downloadUrl", "title", "format"):
                if field not in value:
                    continue
                supported = _iso_quality_unit_label_supported(value[field])
                if field in {"accessUrl", "downloadUrl"}:
                    function = "information" if field == "accessUrl" else "download"
                    supported = supported and any(
                        record is not None
                        and record.get("linkage") == value[field]
                        and record.get("function") == function
                        for record in online_values
                    )
                elif field == "title":
                    supported = supported and any(
                        record is not None and record.get("name") == value[field]
                        for record in online_values
                    )
                else:
                    supported = supported and any(
                        record is not None and record["citation"]["title"] == value[field]
                        for record in format_values
                    )
                (distribution_mapped if supported else distribution_unmapped).append(
                    f"{path}.{field}"
                )
            if bindings:
                distribution_mapped.append(f"{path}.isoTransfer.projections")
    graph_groups = cast(list[dict[str, Any]], catalog.get("isoDistributionGroups", []))
    graph_blocks: list[tuple[ET.Element, str]] = []
    graph_id_paths: dict[str, str] = {}
    graph_failed_groups: set[str] = set()
    graph_id_owners: dict[str, str] = {}
    graph_references: list[tuple[str, str]] = []
    graph_current_owner = ""

    def graph_ownership(value: Any, owner: str) -> None:
        if isinstance(value, dict):
            if "id" in value:
                graph_id_owners[value["id"]] = owner
            if "ref" in value:
                graph_references.append((owner, value["ref"]))
            for nested in value.values():
                graph_ownership(nested, owner)
        elif isinstance(value, list):
            for nested in value:
                graph_ownership(nested, owner)

    def graph_party(parent: ET.Element, value: dict[str, Any], path: str) -> None:
        party = child(
            child(parent, "cit", "party"),
            "cit",
            "CI_Individual" if value["type"] == "individual" else "CI_Organisation",
        )
        graph_party_fields(party, value, path)

    def graph_party_fields(party: ET.Element, value: dict[str, Any], path: str) -> None:
        if "name" in value:
            distribution_text(party, "cit", "name", value["name"], f"{path}.name")
        for contact_index, contact_value in enumerate(value.get("contacts", [])):
            contact_path = f"{path}.contacts[{contact_index}]"
            contact_element = child(child(party, "cit", "contactInfo"), "cit", "CI_Contact")
            for phone_index, phone in enumerate(contact_value.get("phones", [])):
                phone_path = f"{contact_path}.phones[{phone_index}]"
                telephone = child(child(contact_element, "cit", "phone"), "cit", "CI_Telephone")
                distribution_text(
                    telephone, "cit", "number", phone["number"], f"{phone_path}.number"
                )
                if "numberType" in phone:
                    code = child(
                        child(telephone, "cit", "numberType"),
                        "cit",
                        "CI_TelephoneTypeCode",
                        phone["numberType"],
                    )
                    code.set(
                        "codeList",
                        "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_TelephoneTypeCode",
                    )
                    code.set("codeListValue", phone["numberType"])
                    distribution_mapped.append(f"{phone_path}.numberType")
            for address_index, address_value in enumerate(contact_value.get("addresses", [])):
                address_path = f"{contact_path}.addresses[{address_index}]"
                address = child(child(contact_element, "cit", "address"), "cit", "CI_Address")
                for point_index, point in enumerate(address_value.get("deliveryPoints", [])):
                    distribution_text(
                        address,
                        "cit",
                        "deliveryPoint",
                        point,
                        f"{address_path}.deliveryPoints[{point_index}]",
                    )
                for field in ("city", "administrativeArea", "postalCode", "country"):
                    if field in address_value:
                        distribution_text(
                            address, "cit", field, address_value[field], f"{address_path}.{field}"
                        )
                for email_index, email in enumerate(address_value.get("emails", [])):
                    distribution_text(
                        address,
                        "cit",
                        "electronicMailAddress",
                        email,
                        f"{address_path}.emails[{email_index}]",
                    )
            for online_index, online in enumerate(contact_value.get("onlineResources", [])):
                distribution_online_fields(
                    contact_element,
                    online,
                    f"{contact_path}.onlineResources[{online_index}]",
                    prefix="cit",
                    name="onlineResource",
                )
            for hours_index, hours in enumerate(contact_value.get("hoursOfService", [])):
                distribution_text(
                    contact_element,
                    "cit",
                    "hoursOfService",
                    hours,
                    f"{contact_path}.hoursOfService[{hours_index}]",
                )
            for field in ("contactInstructions", "contactType"):
                if field in contact_value:
                    distribution_text(
                        contact_element,
                        "cit",
                        field,
                        contact_value[field],
                        f"{contact_path}.{field}",
                    )
        if value["type"] == "individual" and "positionName" in value:
            distribution_text(
                party, "cit", "positionName", value["positionName"], f"{path}.positionName"
            )
        if value["type"] == "organisation":
            for individual_index, individual_value in enumerate(value.get("individuals", [])):
                individual = child(child(party, "cit", "individual"), "cit", "CI_Individual")
                graph_party_fields(
                    individual,
                    {**individual_value, "type": "individual"},
                    f"{path}.individuals[{individual_index}]",
                )

    def graph_responsibility(parent: ET.Element, value: dict[str, Any], path: str) -> bool:
        role_value = value["role"]
        if not _iso_quality_unit_label_supported(role_value) or any(
            c in role_value for c in "\t\n"
        ):
            distribution_unmapped.append(f"{path}.role")
            return False
        responsibility = child(
            child(parent, "mrd", "distributorContact"), "cit", "CI_Responsibility"
        )
        role_code = child(child(responsibility, "cit", "role"), "cit", "CI_RoleCode", role_value)
        role_code.set(
            "codeList", "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_RoleCode"
        )
        role_code.set("codeListValue", role_value)
        distribution_mapped.append(f"{path}.role")
        for party_index, party_value in enumerate(value["parties"]):
            graph_party(responsibility, party_value, f"{path}.parties[{party_index}]")
        return True

    def graph_node(
        parent: ET.Element,
        property_name: str,
        kind: str,
        value: dict[str, Any],
        path: str,
        *,
        prefix: str = "mrd",
    ) -> None:
        prop = child(parent, prefix, property_name)
        if "ref" in value:
            prop.set(tag("xlink", "href"), f"#{value['ref']}")
            distribution_mapped.append(f"{path}.ref")
            return
        xml_kind = {
            "group": "MD_Distribution",
            "format": "MD_Format",
            "distributor": "MD_Distributor",
            "dto": "MD_DigitalTransferOptions",
            "medium": "MD_Medium",
            "order": "MD_StandardOrderProcess",
        }[kind]
        element = child(prop, "mrd", xml_kind)
        distribution_mapped.append(path)
        if "id" in value:
            element.set("id", value["id"])
            graph_id_paths[value["id"]] = f"{path}.id"
            distribution_mapped.append(f"{path}.id")
        if kind == "group":
            if "description" in value:
                distribution_text(
                    element, "mrd", "description", value["description"], f"{path}.description"
                )
            for field, property_tag, target_kind in (
                ("formats", "distributionFormat", "format"),
                ("distributors", "distributor", "distributor"),
                ("transferOptions", "transferOptions", "dto"),
            ):
                for index, nested in enumerate(value.get(field, [])):
                    graph_node(
                        element, property_tag, target_kind, nested, f"{path}.{field}[{index}]"
                    )
        elif kind == "format":
            if not distribution_format_fields(element, value, path):
                graph_failed_groups.add(graph_current_owner)
                distribution_unmapped.append(path)
                return
            for field, property_tag, target_kind in (
                ("media", "medium", "medium"),
                ("distributors", "formatDistributor", "distributor"),
            ):
                for index, nested in enumerate(value.get(field, [])):
                    graph_node(
                        element, property_tag, target_kind, nested, f"{path}.{field}[{index}]"
                    )
        elif kind == "distributor":
            if not graph_responsibility(element, value["contact"], f"{path}.contact"):
                graph_failed_groups.add(graph_current_owner)
                distribution_unmapped.append(path)
                return
            for field, property_tag, target_kind in (
                ("orders", "distributionOrderProcess", "order"),
                ("formats", "distributorFormat", "format"),
                ("transferOptions", "distributorTransferOptions", "dto"),
            ):
                for index, nested in enumerate(value.get(field, [])):
                    graph_node(
                        element, property_tag, target_kind, nested, f"{path}.{field}[{index}]"
                    )
        elif kind == "dto":
            for field, xml_name, xml_type in (
                ("unitsOfDistribution", "unitsOfDistribution", "CharacterString"),
                ("transferSizeMegabytes", "transferSize", "Real"),
            ):
                if field in value:
                    distribution_text(
                        element, "mrd", xml_name, str(value[field]), f"{path}.{field}", xml_type
                    )
            for index, online in enumerate(value.get("onlineResources", [])):
                if _iso_quality_unit_label_supported(online["linkage"]):
                    distribution_online_fields(element, online, f"{path}.onlineResources[{index}]")
                else:
                    distribution_unmapped.append(f"{path}.onlineResources[{index}]")
            for index, nested in enumerate(value.get("offlineMedia", [])):
                graph_node(element, "offLine", "medium", nested, f"{path}.offlineMedia[{index}]")
            if "transferFrequency" in value:
                distribution_text(
                    element,
                    "mrd",
                    "transferFrequency",
                    value["transferFrequency"],
                    f"{path}.transferFrequency",
                    "TM_PeriodDuration",
                )
            for index, nested in enumerate(value.get("formats", [])):
                graph_node(
                    element, "distributionFormat", "format", nested, f"{path}.formats[{index}]"
                )
        elif kind == "medium":
            distribution_medium_fields(element, value, path)
        else:
            for field, xml_type in (
                ("fees", "CharacterString"),
                ("plannedAvailableDateTime", "DateTime"),
                ("orderingInstructions", "CharacterString"),
                ("turnaround", "CharacterString"),
                ("orderOptionsType", "RecordType"),
                ("orderOptions", "Record"),
            ):
                if field in value:
                    distribution_text(
                        element, "mrd", field, value[field], f"{path}.{field}", xml_type
                    )

    def omit_graph_groups(reason: str, owners: set[str] | None = None) -> None:
        omitted = {path for _, path in graph_blocks} if owners is None else set(owners)
        # Drop referring groups together with targets, preserving unrelated groups.
        while True:
            dependents = {
                owner
                for owner, target in graph_references
                if graph_id_owners.get(target) in omitted
            }
            expanded = omitted | dependents
            if expanded == omitted:
                break
            omitted = expanded
        retained_blocks: list[tuple[ET.Element, str]] = []
        for element, path in graph_blocks:
            if path in omitted:
                root.remove(element)
                distribution_unmapped.append(f"{path}[{reason}]")
            else:
                retained_blocks.append((element, path))
        graph_blocks[:] = retained_blocks
        distribution_mapped[:] = [
            path
            for path in distribution_mapped
            if not any(path == owner or path.startswith(owner + ".") for owner in omitted)
        ]

    for graph_index, graph_group in enumerate(graph_groups):
        graph_path = f"metadata_extensions.opengeo.isoDistributionGroups[{graph_index}]"
        graph_ownership(graph_group, graph_path)
    for graph_index, graph_group in enumerate(graph_groups):
        graph_path = f"metadata_extensions.opengeo.isoDistributionGroups[{graph_index}]"
        graph_current_owner = graph_path
        graph_node(root, "distributionInfo", "group", graph_group, graph_path, prefix="mdb")
        graph_blocks.append((root[-1], graph_path))
    if graph_failed_groups:
        omit_graph_groups("required-owner-unrepresentable", graph_failed_groups)
    quality = cast(list[dict[str, Any]], catalog.get("quality", []))
    if quality:
        quality_info = child(root, "mdb", "dataQualityInfo")
        quality_value = child(quality_info, "mdq", "DQ_DataQuality")
        scope = child(quality_value, "mdq", "scope")
        scope_value = child(scope, "mcc", "MD_Scope")
        level = child(scope_value, "mcc", "level")
        level_value = "dataset" if summary.kind == "dataset" else "service"
        level_code = child(level, "mcc", "MD_ScopeCode", level_value)
        level_code.set(
            "codeList",
            "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_ScopeCode",
        )
        level_code.set("codeListValue", level_value)
        for quality_index, value in enumerate(quality):
            report = child(quality_value, "mdq", "report")
            report_value = child(report, "mdq", "DQ_UsabilityElement")
            measure = child(report_value, "mdq", "measure")
            measure_value = child(measure, "mdq", "DQ_MeasureReference")
            child(
                child(measure_value, "mdq", "nameOfMeasure"),
                "gco",
                "CharacterString",
                value["measure"],
            )
            if value.get("description"):
                child(
                    child(measure_value, "mdq", "measureDescription"),
                    "gco",
                    "CharacterString",
                    value["description"],
                )
            result_property = child(report_value, "mdq", "result")
            result_value = value["result"]
            if isinstance(result_value, str):
                descriptive = child(result_property, "mdq", "DQ_DescriptiveResult")
                child(
                    child(descriptive, "mdq", "statement"),
                    "gco",
                    "CharacterString",
                    result_value,
                )
            else:
                quantitative = child(result_property, "mdq", "DQ_QuantitativeResult")
                scalar = (
                    str(result_value).lower()
                    if isinstance(result_value, bool)
                    else str(result_value)
                )
                child(child(quantitative, "mdq", "value"), "gco", "Record", scalar)
                if (
                    value.get("unit") is not None
                    and not isinstance(result_value, bool)
                    and _iso_quality_unit_label_supported(value["unit"])
                ):
                    unit_property = child(quantitative, "mdq", "valueUnit")
                    unit_definition = child(unit_property, "gml", "UnitDefinition")
                    unit_definition.set(tag("gml", "id"), f"quality-unit-{quality_index}")
                    unit_identifier = child(unit_definition, "gml", "identifier", value["unit"])
                    # The exact native label carries no asserted unit authority or conversion.
                    unit_identifier.set("codeSpace", "")
    quality_reports = cast(list[dict[str, Any]], catalog.get("qualityReports", []))
    quality_mapped: list[str] = []
    quality_unmapped: list[str] = []
    quality_blocks: list[tuple[ET.Element, str]] = []
    quality_id_paths: dict[str, str] = {}

    def quality_scope(parent: ET.Element, name: str, value: dict[str, Any]) -> None:
        scope_value = child(child(parent, "mdq", name), "mcc", "MD_Scope")
        code = child(child(scope_value, "mcc", "level"), "mcc", "MD_ScopeCode", value["level"])
        code.set(
            "codeList",
            "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_ScopeCode",
        )
        code.set("codeListValue", value["level"])

    def quality_invalid_text(value: Any, path: str) -> list[str]:
        if isinstance(value, str):
            return [] if _iso_quality_unit_label_supported(value) else [path]
        if isinstance(value, dict):
            return [
                item
                for key, content in value.items()
                for item in quality_invalid_text(content, f"{path}.{key}")
            ]
        if isinstance(value, list):
            return [
                item
                for index, content in enumerate(value)
                for item in quality_invalid_text(content, f"{path}[{index}]")
            ]
        return []

    quality_eligible: set[tuple[int, int]] = set()
    quality_emitted_ids: set[str] = set()
    for group_index, group_value in enumerate(quality_reports):
        group_path = f"metadata_extensions.opengeo.qualityReports[{group_index}]"
        invalid_scope = quality_invalid_text(group_value["scope"], f"{group_path}.scope")
        if invalid_scope:
            quality_unmapped.extend([*invalid_scope, group_path])
            continue
        for report_index, native_report in enumerate(group_value["reports"]):
            path = f"{group_path}.reports[{report_index}]"
            invalid = quality_invalid_text(native_report, path)
            if native_report["type"] not in ISO_QUALITY_REPORT_TYPES:
                invalid.append(f"{path}.type")
            native_evaluation = native_report.get("evaluation")
            if native_evaluation and native_evaluation["type"] not in ISO_QUALITY_EVALUATION_TYPES:
                invalid.append(f"{path}.evaluation.type")
            if invalid:
                quality_unmapped.extend([*invalid, path])
                continue
            quality_eligible.add((group_index, report_index))
            if "id" in native_report:
                quality_emitted_ids.add(native_report["id"])
                quality_id_paths[native_report["id"]] = f"{path}.id"

    for group_index, group_value in enumerate(quality_reports):
        group_path = f"metadata_extensions.opengeo.qualityReports[{group_index}]"
        if not any(
            (group_index, index) in quality_eligible for index in range(len(group_value["reports"]))
        ):
            continue
        quality_info = child(root, "mdb", "dataQualityInfo")
        quality_blocks.append((quality_info, group_path))
        quality_value = child(quality_info, "mdq", "DQ_DataQuality")
        quality_scope(quality_value, "scope", group_value["scope"])
        quality_mapped.append(f"{group_path}.scope.level")
        for report_index, value in enumerate(group_value["reports"]):
            if (group_index, report_index) not in quality_eligible:
                continue
            path = f"{group_path}.reports[{report_index}]"
            report_value = child(child(quality_value, "mdq", "report"), "mdq", value["type"])
            quality_mapped.append(f"{path}.type")
            if "id" in value:
                report_value.set("id", value["id"])
                quality_mapped.append(f"{path}.id")
            if "standaloneDetails" in value:
                child(
                    child(report_value, "mdq", "standaloneQualityReportDetails"),
                    "gco",
                    "CharacterString",
                    value["standaloneDetails"],
                )
                quality_mapped.append(f"{path}.standaloneDetails")
            if "measure" in value:
                measure = child(child(report_value, "mdq", "measure"), "mdq", "DQ_MeasureReference")
                native_measure = value["measure"]
                if "identifier" in native_measure:
                    identifier_value = native_measure["identifier"]
                    identifier = child(
                        child(measure, "mdq", "measureIdentification"), "mcc", "MD_Identifier"
                    )
                    child(
                        child(identifier, "mcc", "code"),
                        "gco",
                        "CharacterString",
                        identifier_value["code"],
                    )
                    if "codeSpace" in identifier_value:
                        child(
                            child(identifier, "mcc", "codeSpace"),
                            "gco",
                            "CharacterString",
                            identifier_value["codeSpace"],
                        )
                for name in native_measure.get("names", []):
                    child(child(measure, "mdq", "nameOfMeasure"), "gco", "CharacterString", name)
                if "description" in native_measure:
                    child(
                        child(measure, "mdq", "measureDescription"),
                        "gco",
                        "CharacterString",
                        native_measure["description"],
                    )
                quality_mapped.append(f"{path}.measure")
            if "evaluation" in value:
                evaluation_value = value["evaluation"]
                evaluation_path = f"{path}.evaluation"
                evaluation = child(
                    child(report_value, "mdq", "evaluationMethod"), "mdq", evaluation_value["type"]
                )
                for date_time in evaluation_value.get("dateTimes", []):
                    child(child(evaluation, "mdq", "dateTime"), "gco", "DateTime", date_time)
                if "description" in evaluation_value:
                    child(
                        child(evaluation, "mdq", "evaluationMethodDescription"),
                        "gco",
                        "CharacterString",
                        evaluation_value["description"],
                    )
                if "procedure" in evaluation_value:
                    distribution_citation(
                        evaluation,
                        evaluation_value["procedure"],
                        f"{evaluation_path}.procedure",
                        prefix="mdq",
                        name="evaluationProcedure",
                        mapped=quality_mapped,
                        unmapped=quality_unmapped,
                    )
                for index, citation in enumerate(evaluation_value.get("referenceDocuments", [])):
                    distribution_citation(
                        evaluation,
                        citation,
                        f"{evaluation_path}.referenceDocuments[{index}]",
                        prefix="mdq",
                        name="referenceDoc",
                        mapped=quality_mapped,
                        unmapped=quality_unmapped,
                    )
                if "methodType" in evaluation_value:
                    code = child(
                        child(evaluation, "mdq", "evaluationMethodType"),
                        "mdq",
                        "DQ_EvaluationMethodTypeCode",
                        evaluation_value["methodType"],
                    )
                    code.set(
                        "codeList",
                        "https://schemas.isotc211.org/resources/codelists/codelists.xml#DQ_EvaluationMethodTypeCode",
                    )
                    code.set("codeListValue", evaluation_value["methodType"])
                if evaluation_value["type"] == "DQ_IndirectEvaluation":
                    for source in evaluation_value["deductiveSources"]:
                        child(
                            child(evaluation, "mdq", "deductiveSource"),
                            "gco",
                            "CharacterString",
                            source,
                        )
                if evaluation_value["type"] == "DQ_SampleBasedInspection":
                    for field in ("samplingScheme", "lotDescription", "samplingRatio"):
                        child(
                            child(evaluation, "mdq", field),
                            "gco",
                            "CharacterString",
                            evaluation_value[field],
                        )
                quality_mapped.append(evaluation_path)
            for result_index, result_value in enumerate(value["results"]):
                result_path = f"{path}.results[{result_index}]"
                result_element = child(
                    child(report_value, "mdq", "result"), "mdq", result_value["type"]
                )
                if "dateTime" in result_value:
                    child(
                        child(result_element, "mdq", "dateTime"),
                        "gco",
                        "DateTime",
                        result_value["dateTime"],
                    )
                if "scope" in result_value:
                    quality_scope(result_element, "resultScope", result_value["scope"])
                if result_value["type"] == "DQ_DescriptiveResult":
                    child(
                        child(result_element, "mdq", "statement"),
                        "gco",
                        "CharacterString",
                        result_value["statement"],
                    )
                elif result_value["type"] == "DQ_QuantitativeResult":
                    for lexical_value in result_value["values"]:
                        child(child(result_element, "mdq", "value"), "gco", "Record", lexical_value)
                    if "unit" in result_value:
                        definition = child(
                            child(result_element, "mdq", "valueUnit"), "gml", "UnitDefinition"
                        )
                        definition.set(
                            tag("gml", "id"),
                            f"quality-report-unit-{group_index}-{report_index}-{result_index}",
                        )
                        identifier = child(definition, "gml", "identifier", result_value["unit"])
                        identifier.set("codeSpace", "")
                    elif "unitReference" in result_value:
                        unit = child(result_element, "mdq", "valueUnit")
                        for attribute, attribute_value in result_value["unitReference"].items():
                            unit.set(
                                attribute if attribute == "uuidref" else tag("xlink", attribute),
                                attribute_value,
                            )
                        quality_mapped.append(f"{result_path}.unitReference")
                    if "recordType" in result_value:
                        child(
                            child(result_element, "mdq", "valueRecordType"),
                            "gco",
                            "RecordType",
                            result_value["recordType"],
                        )
                else:
                    distribution_citation(
                        result_element,
                        result_value["specification"],
                        f"{result_path}.specification",
                        prefix="mdq",
                        name="specification",
                        mapped=quality_mapped,
                        unmapped=quality_unmapped,
                    )
                    if "explanation" in result_value:
                        child(
                            child(result_element, "mdq", "explanation"),
                            "gco",
                            "CharacterString",
                            result_value["explanation"],
                        )
                    child(
                        child(result_element, "mdq", "pass"),
                        "gco",
                        "Boolean",
                        "true" if result_value["pass"] else "false",
                    )
                quality_mapped.append(result_path)
            for field, xml_name in (
                ("derivedReports", "derivedElement"),
                ("relatedReports", "relatedElement"),
            ):
                for index, reference in enumerate(value.get(field, [])):
                    reference_path = f"{path}.{field}[{index}]"
                    if reference not in quality_emitted_ids:
                        quality_unmapped.append(reference_path)
                        continue
                    child(report_value, "mdq", xml_name).set(tag("xlink", "href"), f"#{reference}")
                    quality_mapped.append(reference_path)
    lineage = catalog.get("lineage")
    if isinstance(lineage, dict):
        lineage_info = child(root, "mdb", "resourceLineage")
        lineage_value = child(lineage_info, "mrl", "LI_Lineage")
        child(
            child(lineage_value, "mrl", "statement"),
            "gco",
            "CharacterString",
            lineage["statement"],
        )
        for source in cast(list[str], lineage.get("sources", [])):
            source_info = child(lineage_value, "mrl", "source")
            source_value = child(source_info, "mrl", "LI_Source")
            child(
                child(source_value, "mrl", "description"),
                "gco",
                "CharacterString",
                source,
            )
    acquisition = catalog.get("acquisition")
    acquisition_context_mapped: list[str] = []
    acquisition_context_unmapped: list[str] = []
    acquisition_context_blocks: list[tuple[ET.Element, ET.Element, str, str | None]] = []
    acquisition_emitted = False
    if isinstance(acquisition, dict):
        acquisition_info = child(root, "mdb", "acquisitionInformation")
        acquisition_value = child(acquisition_info, "mac", "MI_AcquisitionInformation")
        extent_period_index = 0

        def omit_citation(value: dict[str, Any], path: str) -> None:
            for field, content in value.items():
                if isinstance(content, list):
                    acquisition_context_unmapped.extend(
                        f"{path}.{field}[{index}]" for index in range(len(content))
                    )
                else:
                    acquisition_context_unmapped.append(f"{path}.{field}")

        def emit_context_extent(parent: ET.Element, value: dict[str, Any], path: str) -> None:
            nonlocal extent_period_index
            extent_value = ET.Element(tag("gex", "EX_Extent"))
            if "description" in value:
                if _iso_quality_unit_label_supported(value["description"]):
                    child(
                        child(extent_value, "gex", "description"),
                        "gco",
                        "CharacterString",
                        value["description"],
                    )
                    acquisition_context_mapped.append(f"{path}.description")
                else:
                    acquisition_context_unmapped.append(f"{path}.description")
            for index, bounds in enumerate(value.get("geographicBounds", [])):
                geographic = child(extent_value, "gex", "geographicElement")
                box = child(geographic, "gex", "EX_GeographicBoundingBox")
                if "extentTypeCode" in bounds:
                    child(
                        child(box, "gex", "extentTypeCode"),
                        "gco",
                        "Boolean",
                        str(bounds["extentTypeCode"]).lower(),
                    )
                for field, name in (
                    ("west", "westBoundLongitude"),
                    ("east", "eastBoundLongitude"),
                    ("south", "southBoundLatitude"),
                    ("north", "northBoundLatitude"),
                ):
                    child(
                        child(box, "gex", name),
                        "gco",
                        "Decimal",
                        format(Decimal(str(bounds[field])), "f"),
                    )
                acquisition_context_mapped.append(f"{path}.geographicBounds[{index}]")
            temporal_value = value.get("temporal")
            if isinstance(temporal_value, dict):
                if all(
                    _iso_quality_unit_label_supported(temporal_value[field])
                    for field in ("start", "end")
                ):
                    temporal = child(extent_value, "gex", "temporalElement")
                    temporal_extent = child(temporal, "gex", "EX_TemporalExtent")
                    period_property = child(temporal_extent, "gex", "extent")
                    period = child(period_property, "gml", "TimePeriod")
                    extent_period_index += 1
                    period.set(tag("gml", "id"), f"acquisition-extent-period-{extent_period_index}")
                    child(period, "gml", "beginPosition", temporal_value["start"])
                    child(period, "gml", "endPosition", temporal_value["end"])
                    acquisition_context_mapped.append(f"{path}.temporal")
                else:
                    acquisition_context_unmapped.append(f"{path}.temporal")
            if len(extent_value):
                extent_property = child(parent, "mac", "extent")
                extent_property.append(extent_value)
                acquisition_context_blocks.append((parent, extent_property, path, None))
            else:
                acquisition_context_unmapped.append(path)

        def emit_context_citation(
            parent: ET.Element,
            value: dict[str, Any],
            path: str,
            *,
            plan_identifier: str | None = None,
        ) -> bool:
            if not _iso_quality_unit_label_supported(value["title"]):
                omit_citation(value, path)
                return False
            if plan_identifier is not None and not _iso_quality_unit_label_supported(
                plan_identifier
            ):
                omit_citation(value, path)
                return False
            citation_property = child(parent, "mac", "citation")
            citation = child(citation_property, "cit", "CI_Citation")
            child(child(citation, "cit", "title"), "gco", "CharacterString", value["title"])
            acquisition_context_mapped.append(f"{path}.title")
            for index, alternate in enumerate(value.get("alternateTitles", [])):
                if _iso_quality_unit_label_supported(alternate):
                    child(
                        child(citation, "cit", "alternateTitle"),
                        "gco",
                        "CharacterString",
                        alternate,
                    )
                    acquisition_context_mapped.append(f"{path}.alternateTitles[{index}]")
                else:
                    acquisition_context_unmapped.append(f"{path}.alternateTitles[{index}]")
            for index, citation_date in enumerate(value.get("dates", [])):
                if all(
                    _iso_quality_unit_label_supported(citation_date[field])
                    for field in ("date", "dateType")
                ):
                    date = child(child(citation, "cit", "date"), "cit", "CI_Date")
                    child(child(date, "cit", "date"), "gco", "Date", citation_date["date"])
                    date_code = child(
                        child(date, "cit", "dateType"),
                        "cit",
                        "CI_DateTypeCode",
                        citation_date["dateType"],
                    )
                    date_code.set(
                        "codeList",
                        "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_DateTypeCode",
                    )
                    date_code.set("codeListValue", citation_date["dateType"])
                    acquisition_context_mapped.append(f"{path}.dates[{index}]")
                else:
                    acquisition_context_unmapped.append(f"{path}.dates[{index}]")
            for field, xml_type in (("edition", "CharacterString"), ("editionDate", "DateTime")):
                if field in value:
                    if _iso_quality_unit_label_supported(value[field]):
                        child(child(citation, "cit", field), "gco", xml_type, value[field])
                        acquisition_context_mapped.append(f"{path}.{field}")
                    else:
                        acquisition_context_unmapped.append(f"{path}.{field}")

            def citation_identifier(identifier_value: dict[str, str]) -> None:
                identifier = child(child(citation, "cit", "identifier"), "mcc", "MD_Identifier")
                child(
                    child(identifier, "mcc", "code"),
                    "gco",
                    "CharacterString",
                    identifier_value["code"],
                )
                if "codeSpace" in identifier_value:
                    child(
                        child(identifier, "mcc", "codeSpace"),
                        "gco",
                        "CharacterString",
                        identifier_value["codeSpace"],
                    )

            if plan_identifier is not None:
                citation_identifier(
                    {"code": plan_identifier, "codeSpace": "urn:opengeo:catalog:acquisition-plan"}
                )
            for index, identifier_value in enumerate(value.get("identifiers", [])):
                if all(
                    _iso_quality_unit_label_supported(content)
                    for content in identifier_value.values()
                ):
                    citation_identifier(identifier_value)
                    acquisition_context_mapped.append(f"{path}.identifiers[{index}]")
                else:
                    acquisition_context_unmapped.append(f"{path}.identifiers[{index}]")
            for field, name in (("isbn", "ISBN"), ("issn", "ISSN")):
                if field in value:
                    if _iso_quality_unit_label_supported(value[field]):
                        child(child(citation, "cit", name), "gco", "CharacterString", value[field])
                        acquisition_context_mapped.append(f"{path}.{field}")
                    else:
                        acquisition_context_unmapped.append(f"{path}.{field}")
            acquisition_context_blocks.append((parent, citation_property, path, plan_identifier))
            return True

        instrument_xml_ids: dict[str, str] = {}
        for index, value in enumerate(
            cast(list[dict[str, str]], acquisition.get("instruments", [])), start=1
        ):
            instrument_info = child(acquisition_value, "mac", "instrument")
            instrument = child(instrument_info, "mac", "MI_Instrument")
            xml_id = f"opengeo-instrument-{index}"
            instrument.set("id", xml_id)
            instrument_xml_ids[value["identifier"]] = xml_id
            instrument_identifier = child(instrument, "mac", "identifier")
            instrument_identifier_value = child(instrument_identifier, "mcc", "MD_Identifier")
            child(
                child(instrument_identifier_value, "mcc", "code"),
                "gco",
                "CharacterString",
                value["identifier"],
            )
            child(
                child(instrument, "mac", "type"),
                "gco",
                "CharacterString",
                value["type"],
            )
            if value.get("description"):
                child(
                    child(instrument, "mac", "description"),
                    "gco",
                    "CharacterString",
                    value["description"],
                )
        operation_records = cast(list[dict[str, Any]], acquisition.get("operations", []))
        operation_xml_ids = {
            value["identifier"]: f"opengeo-operation-{index}"
            for index, value in enumerate(operation_records, start=1)
        }
        objective_records = cast(list[dict[str, Any]], acquisition.get("objectives", []))
        objective_xml_ids = {
            value["identifier"]: f"opengeo-objective-{index}"
            for index, value in enumerate(objective_records, start=1)
        }
        platform_pass_records = cast(list[dict[str, Any]], acquisition.get("platformPasses", []))
        platform_pass_by_identifier = {
            value["identifier"]: value for value in platform_pass_records
        }
        platform_pass_indices = {
            value["identifier"]: index for index, value in enumerate(platform_pass_records)
        }
        platform_pass_xml_ids = {
            value["identifier"]: f"opengeo-platform-pass-{index}"
            for index, value in enumerate(platform_pass_records, start=1)
        }
        event_records = cast(list[dict[str, Any]], acquisition.get("events", []))
        event_by_identifier = {value["identifier"]: value for value in event_records}
        event_xml_ids = {
            value["identifier"]: f"opengeo-event-{index}"
            for index, value in enumerate(event_records, start=1)
        }
        emitted_platform_passes: set[str] = set()
        emitted_events: set[str] = set()

        def acquisition_identifier(parent: ET.Element, name: str, value: str) -> None:
            identifier_info = child(parent, "mac", name)
            identifier_value = child(identifier_info, "mcc", "MD_Identifier")
            child(child(identifier_value, "mcc", "code"), "gco", "CharacterString", value)

        def acquisition_code(
            parent: ET.Element, property_name: str, code_name: str, value: str
        ) -> None:
            code_info = child(parent, "mac", property_name)
            code = child(code_info, "mac", code_name, value)
            code.set(
                "codeList",
                f"https://schemas.isotc211.org/resources/codelists/codelists.xml#{code_name}",
            )
            code.set("codeListValue", value)

        def emit_event(property_element: ET.Element, value: dict[str, Any]) -> None:
            identifier = cast(str, value["identifier"])
            emitted_events.add(identifier)
            event = child(property_element, "mac", "MI_Event")
            event.set("id", event_xml_ids[identifier])
            acquisition_identifier(event, "identifier", identifier)
            acquisition_code(event, "trigger", "MI_TriggerCode", value["trigger"])
            acquisition_code(event, "context", "MI_ContextCode", value["context"])
            acquisition_code(event, "sequence", "MI_SequenceCode", value["sequence"])
            child(child(event, "mac", "time"), "gco", "DateTime", value["time"])
            if pass_identifier := value.get("passIdentifier"):
                pass_reference = child(event, "mac", "relatedPass")
                if pass_identifier in emitted_platform_passes:
                    pass_reference.set(
                        tag("xlink", "href"), f"#{platform_pass_xml_ids[pass_identifier]}"
                    )
                else:
                    emit_platform_pass(pass_reference, platform_pass_by_identifier[pass_identifier])
            for instrument_identifier in cast(list[str], value.get("instrumentIdentifiers", [])):
                instrument_reference = child(event, "mac", "relatedSensor")
                instrument_reference.set(
                    tag("xlink", "href"), f"#{instrument_xml_ids[instrument_identifier]}"
                )
            for objective_identifier in cast(list[str], value.get("objectiveIdentifiers", [])):
                objective_reference = child(event, "mac", "expectedObjective")
                objective_reference.set(
                    tag("xlink", "href"), f"#{objective_xml_ids[objective_identifier]}"
                )

        def emit_platform_pass(property_element: ET.Element, value: dict[str, Any]) -> None:
            identifier = cast(str, value["identifier"])
            emitted_platform_passes.add(identifier)
            platform_pass = child(property_element, "mac", "MI_PlatformPass")
            platform_pass.set("id", platform_pass_xml_ids[identifier])
            acquisition_identifier(platform_pass, "identifier", identifier)
            if isinstance(value.get("extent"), dict):
                emit_context_extent(
                    platform_pass,
                    value["extent"],
                    "metadata_extensions.opengeo.acquisition.platformPasses"
                    f"[{platform_pass_indices[identifier]}].extent",
                )
            for event_identifier in cast(list[str], value.get("eventIdentifiers", [])):
                event_reference = child(platform_pass, "mac", "relatedEvent")
                if event_identifier in emitted_events:
                    event_reference.set(tag("xlink", "href"), f"#{event_xml_ids[event_identifier]}")
                else:
                    emit_event(event_reference, event_by_identifier[event_identifier])

        for value in operation_records:
            operation_info = child(acquisition_value, "mac", "operation")
            operation = child(operation_info, "mac", "MI_Operation")
            operation.set("id", operation_xml_ids[value["identifier"]])
            if value.get("description"):
                child(
                    child(operation, "mac", "description"),
                    "gco",
                    "CharacterString",
                    value["description"],
                )
            operation_identifier = child(operation, "mac", "identifier")
            operation_identifier_value = child(operation_identifier, "mcc", "MD_Identifier")
            child(
                child(operation_identifier_value, "mcc", "code"),
                "gco",
                "CharacterString",
                value["identifier"],
            )
            status = child(operation, "mac", "status")
            status_code = child(status, "mcc", "MD_ProgressCode", value["status"])
            status_code.set(
                "codeList",
                "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_ProgressCode",
            )
            status_code.set("codeListValue", value["status"])
            if value.get("type"):
                operation_type = child(operation, "mac", "type")
                operation_type_code = child(
                    operation_type, "mac", "MI_OperationTypeCode", value["type"]
                )
                operation_type_code.set(
                    "codeList",
                    "https://schemas.isotc211.org/resources/codelists/codelists.xml#MI_OperationTypeCode",
                )
                operation_type_code.set("codeListValue", value["type"])
            for event_identifier in cast(list[str], value.get("eventIdentifiers", [])):
                event_reference = child(operation, "mac", "significantEvent")
                if event_identifier in emitted_events:
                    event_reference.set(tag("xlink", "href"), f"#{event_xml_ids[event_identifier]}")
                else:
                    emit_event(event_reference, event_by_identifier[event_identifier])
        for value in cast(list[dict[str, Any]], acquisition.get("platforms", [])):
            platform_info = child(acquisition_value, "mac", "platform")
            platform = child(platform_info, "mac", "MI_Platform")
            platform_identifier = child(platform, "mac", "identifier")
            platform_identifier_value = child(platform_identifier, "mcc", "MD_Identifier")
            child(
                child(platform_identifier_value, "mcc", "code"),
                "gco",
                "CharacterString",
                value["identifier"],
            )
            child(
                child(platform, "mac", "description"),
                "gco",
                "CharacterString",
                value["description"],
            )
            for referenced_identifier in cast(list[str], value["instrumentIdentifiers"]):
                instrument_reference = child(platform, "mac", "instrument")
                instrument_reference.set(
                    tag("xlink", "href"),
                    f"#{instrument_xml_ids[referenced_identifier]}",
                )
        requirement_records = cast(list[dict[str, Any]], acquisition.get("requirements", []))
        requirement_xml_ids = {
            value["identifier"]: f"opengeo-requirement-{index}"
            for index, value in enumerate(requirement_records, start=1)
        }
        plan_records = cast(list[dict[str, Any]], acquisition.get("plans", []))
        plan_xml_ids = {
            value["identifier"]: f"opengeo-plan-{index}"
            for index, value in enumerate(plan_records, start=1)
        }
        emitted_plan_identifiers: set[str] = set()
        for plan_index, value in enumerate(plan_records):
            if not _iso_quality_unit_label_supported(value["identifier"]):
                acquisition_context_unmapped.append(
                    f"metadata_extensions.opengeo.acquisition.plans[{plan_index}]"
                )
                continue
            plan_info = child(acquisition_value, "mac", "acquisitionPlan")
            plan = child(plan_info, "mac", "MI_Plan")
            plan.set("id", plan_xml_ids[value["identifier"]])
            emitted_plan_identifiers.add(value["identifier"])
            if value.get("type"):
                plan_type = child(plan, "mac", "type")
                plan_type_code = child(plan_type, "mac", "MI_GeometryTypeCode", value["type"])
                plan_type_code.set(
                    "codeList",
                    "https://schemas.isotc211.org/resources/codelists/codelists.xml#MI_GeometryTypeCode",
                )
                plan_type_code.set("codeListValue", value["type"])
            plan_status = child(plan, "mac", "status")
            plan_status_code = child(plan_status, "mcc", "MD_ProgressCode", value["status"])
            plan_status_code.set(
                "codeList",
                "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_ProgressCode",
            )
            plan_status_code.set("codeListValue", value["status"])
            plan_citation_record = value.get("citation")
            if not isinstance(plan_citation_record, dict) or not emit_context_citation(
                plan,
                plan_citation_record,
                f"metadata_extensions.opengeo.acquisition.plans[{plan_index}].citation",
                plan_identifier=value["identifier"],
            ):
                plan_citation = child(plan, "mac", "citation")
                plan_citation_value = child(plan_citation, "cit", "CI_Citation")
                child(
                    child(plan_citation_value, "cit", "title"),
                    "gco",
                    "CharacterString",
                    value["identifier"],
                )
            for referenced_operation in cast(list[str], value.get("operationIdentifiers", [])):
                operation_reference = child(plan, "mac", "operation")
                operation_reference.set(
                    tag("xlink", "href"),
                    f"#{operation_xml_ids[referenced_operation]}",
                )
            for requirement_identifier in cast(list[str], value.get("requirementIdentifiers", [])):
                requirement_reference = child(plan, "mac", "satisfiedRequirement")
                requirement_reference.set(
                    tag("xlink", "href"),
                    f"#{requirement_xml_ids[requirement_identifier]}",
                )
        for objective_index, value in enumerate(objective_records):
            objective_info = child(acquisition_value, "mac", "objective")
            objective = child(objective_info, "mac", "MI_Objective")
            objective.set("id", objective_xml_ids[value["identifier"]])
            objective_identifier = child(objective, "mac", "identifier")
            objective_identifier_value = child(objective_identifier, "mcc", "MD_Identifier")
            child(
                child(objective_identifier_value, "mcc", "code"),
                "gco",
                "CharacterString",
                value["identifier"],
            )
            if value.get("priority"):
                child(
                    child(objective, "mac", "priority"),
                    "gco",
                    "CharacterString",
                    value["priority"],
                )
            for objective_type in cast(list[str], value.get("types", [])):
                objective_type_info = child(objective, "mac", "type")
                objective_type_code = child(
                    objective_type_info,
                    "mac",
                    "MI_ObjectiveTypeCode",
                    objective_type,
                )
                objective_type_code.set(
                    "codeList",
                    "https://schemas.isotc211.org/resources/codelists/codelists.xml#MI_ObjectiveTypeCode",
                )
                objective_type_code.set("codeListValue", objective_type)
            for function_value in cast(list[str], value.get("functions", [])):
                child(
                    child(objective, "mac", "function"),
                    "gco",
                    "CharacterString",
                    function_value,
                )
            for extent_index, extent_value in enumerate(value.get("extents", [])):
                emit_context_extent(
                    objective,
                    extent_value,
                    "metadata_extensions.opengeo.acquisition.objectives"
                    f"[{objective_index}].extents[{extent_index}]",
                )
            for referenced_instrument in cast(list[str], value.get("instrumentIdentifiers", [])):
                instrument_reference = child(objective, "mac", "sensingInstrument")
                instrument_reference.set(
                    tag("xlink", "href"),
                    f"#{instrument_xml_ids[referenced_instrument]}",
                )
            for pass_identifier in cast(list[str], value.get("passIdentifiers", [])):
                pass_reference = child(objective, "mac", "pass")
                if pass_identifier in emitted_platform_passes:
                    pass_reference.set(
                        tag("xlink", "href"), f"#{platform_pass_xml_ids[pass_identifier]}"
                    )
                else:
                    emit_platform_pass(pass_reference, platform_pass_by_identifier[pass_identifier])
            for event_identifier in cast(list[str], value.get("eventIdentifiers", [])):
                event_reference = child(objective, "mac", "objectiveOccurence")
                if event_identifier in emitted_events:
                    event_reference.set(tag("xlink", "href"), f"#{event_xml_ids[event_identifier]}")
                else:
                    emit_event(event_reference, event_by_identifier[event_identifier])
        for requirement_index, value in enumerate(requirement_records):
            requirement_info = child(acquisition_value, "mac", "acquisitionRequirement")
            requirement = child(requirement_info, "mac", "MI_Requirement")
            requirement.set("id", requirement_xml_ids[value["identifier"]])
            if isinstance(value.get("citation"), dict):
                emit_context_citation(
                    requirement,
                    value["citation"],
                    "metadata_extensions.opengeo.acquisition.requirements"
                    f"[{requirement_index}].citation",
                )
            requirement_identifier_info = child(requirement, "mac", "identifier")
            requirement_identifier_value = child(
                requirement_identifier_info, "mcc", "MD_Identifier"
            )
            child(
                child(requirement_identifier_value, "mcc", "code"),
                "gco",
                "CharacterString",
                value["identifier"],
            )
            for property_name, role_value, parties in (
                ("requestor", "originator", value["requestors"]),
                ("recipient", "recipient", value["recipients"]),
            ):
                for party_name in cast(list[str], parties):
                    responsibility_info = child(requirement, "mac", property_name)
                    responsibility = child(responsibility_info, "cit", "CI_Responsibility")
                    role = child(responsibility, "cit", "role")
                    role_code = child(role, "cit", "CI_RoleCode", role_value)
                    role_code.set(
                        "codeList",
                        "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_RoleCode",
                    )
                    role_code.set("codeListValue", role_value)
                    party_info = child(responsibility, "cit", "party")
                    party = child(party_info, "cit", "CI_Organisation")
                    child(
                        child(party, "cit", "name"),
                        "gco",
                        "CharacterString",
                        party_name,
                    )
            priority = child(requirement, "mac", "priority")
            priority_code = child(priority, "mac", "MI_PriorityCode", value["priority"])
            priority_code.set(
                "codeList",
                "https://schemas.isotc211.org/resources/codelists/codelists.xml#MI_PriorityCode",
            )
            priority_code.set("codeListValue", value["priority"])
            requested_date_info = child(requirement, "mac", "requestedDate")
            requested_date = child(requested_date_info, "mac", "MI_RequestedDate")
            child(
                child(requested_date, "mac", "requestedDateOfCollection"),
                "gco",
                "DateTime",
                value["requestedDate"]["requestedDateOfCollection"],
            )
            child(
                child(requested_date, "mac", "latestAcceptableDate"),
                "gco",
                "DateTime",
                value["requestedDate"]["latestAcceptableDate"],
            )
            child(
                child(requirement, "mac", "expiryDate"),
                "gco",
                "DateTime",
                value["expiryDate"],
            )
            for plan_value in plan_records:
                if plan_value["identifier"] in emitted_plan_identifiers and value[
                    "identifier"
                ] in plan_value.get("requirementIdentifiers", []):
                    # The pinned ISO schema deliberately spells this property satisifiedPlan.
                    inverse_plan = child(requirement, "mac", "satisifiedPlan")
                    inverse_plan.set(
                        tag("xlink", "href"), f"#{plan_xml_ids[plan_value['identifier']]}"
                    )
        environmental_value = acquisition.get("environmentalConditions")
        if isinstance(environmental_value, dict):
            environmental = ET.Element(tag("mac", "MI_EnvironmentalRecord"))
            for field, xml_name in (
                ("averageAirTemperature", "averageAirTemperature"),
                ("maxRelativeHumidity", "maxRelativeHumidity"),
                ("maxAltitude", "maxAltitude"),
                ("meteorologicalConditions", "meterologicalConditions"),
                ("solarAzimuth", "solarAzimuth"),
                ("solarElevation", "solarElevation"),
            ):
                if field not in environmental_value:
                    continue
                path = f"metadata_extensions.opengeo.acquisition.environmentalConditions.{field}"
                field_value = environmental_value[field]
                if isinstance(field_value, str) and not _iso_quality_unit_label_supported(
                    field_value
                ):
                    acquisition_context_unmapped.append(path)
                    continue
                child(
                    child(environmental, "mac", xml_name),
                    "gco",
                    "CharacterString" if field == "meteorologicalConditions" else "Real",
                    str(field_value),
                )
                acquisition_context_mapped.append(path)
            if len(environmental):
                environmental_property = child(acquisition_value, "mac", "environmentalConditions")
                environmental_property.append(environmental)
                acquisition_context_blocks.append(
                    (
                        acquisition_value,
                        environmental_property,
                        "metadata_extensions.opengeo.acquisition.environmentalConditions",
                        None,
                    )
                )
        acquisition_emitted = bool(len(acquisition_value))
    # XML IDs share one document-wide namespace, including gml:id and locale IDs.
    # Preserve native report identity exactly; ambiguous joins cannot be exported.
    quality_id_collisions: list[str] = []
    if quality_reports or graph_groups:
        xml_id_counts: dict[str, int] = {}
        for element in root.iter():
            for attribute in ("id", tag("gml", "id")):
                xml_identifier = element.get(attribute)
                if xml_identifier is not None:
                    xml_id_counts[xml_identifier] = xml_id_counts.get(xml_identifier, 0) + 1
        emitted_id_paths = {**quality_id_paths, **graph_id_paths}
        quality_id_collisions = [
            emitted_id_paths.get(
                identifier,
                "metadata_extensions.opengeo.isoDistributionGroups"
                if graph_groups
                else "metadata_extensions.opengeo.qualityReports",
            )
            for identifier, count in xml_id_counts.items()
            if count > 1
        ]
        quality_unmapped.extend(
            path
            for path in quality_id_collisions
            if not path.startswith("metadata_extensions.opengeo.isoDistributionGroups")
        )
        distribution_unmapped.extend(
            path
            for path in quality_id_collisions
            if path.startswith("metadata_extensions.opengeo.isoDistributionGroups")
        )

    def quality_xml_within_bounds() -> bool:
        if len(ET.tostring(root, encoding="utf-8", xml_declaration=True)) > 49_152:
            return False
        pending = [(root, 1)]
        node_count = 0
        while pending:
            element, depth = pending.pop()
            node_count += 1
            if node_count > 2000 or depth > 32:
                return False
            pending.extend((element_child, depth + 1) for element_child in element)
        return True

    def omit_quality_blocks(reason: str) -> None:
        for element, path in quality_blocks:
            root.remove(element)
            quality_unmapped.append(f"{path}[{reason}]")
        quality_blocks.clear()
        quality_mapped.clear()

    while graph_blocks and not quality_xml_within_bounds():
        omit_graph_groups("xml-limit", {graph_blocks[-1][1]})
    # New context can expand compact native numbers into much larger XML decimals.
    # Keep the existing source-import bound and report every removed native field.
    context_was_emitted = bool(acquisition_context_blocks)
    xml_size = len(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    while xml_size > 49_152 and acquisition_context_blocks:
        parent, element, path, plan_identifier = acquisition_context_blocks.pop()
        position = list(parent).index(element)
        parent.remove(element)
        if plan_identifier is not None:
            fallback = ET.Element(tag("mac", "citation"))
            citation = child(fallback, "cit", "CI_Citation")
            child(child(citation, "cit", "title"), "gco", "CharacterString", plan_identifier)
            parent.insert(position, fallback)
        removed = [p for p in acquisition_context_mapped if p == path or p.startswith(path + ".")]
        acquisition_context_mapped = [p for p in acquisition_context_mapped if p not in removed]
        acquisition_context_unmapped.extend([*removed, f"{path}[size-limit]"])
        xml_size = len(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    if isinstance(acquisition, dict):
        acquisition_emitted = bool(len(acquisition_value))
        if not acquisition_emitted:
            root.remove(acquisition_info)
            xml_size = len(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    distribution_was_emitted = bool(distribution_blocks)
    while distribution_blocks and (
        xml_size > 49_152 or (offline_media_present and not quality_xml_within_bounds())
    ):
        parent, element, path = distribution_blocks.pop()
        parent.remove(element)
        if not len(parent):
            root.remove(distribution_wrappers.pop(parent))
        removed = [p for p in distribution_mapped if p == path or p.startswith(path + ".")]
        distribution_mapped = [p for p in distribution_mapped if p not in removed]
        distribution_unmapped.extend([*removed, f"{path}[size-limit]"])
        xml_size = len(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    if quality_reports and not quality_xml_within_bounds():
        # Omit typed groups together so local references never become dangling.
        omit_quality_blocks("xml-limit")
        xml_size = len(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    context_size_blocked = (
        (context_was_emitted or distribution_was_emitted) and xml_size > 49_152
    ) or (
        bool(quality_reports or offline_media_present or graph_groups)
        and not quality_xml_within_bounds()
    )
    iso_catalog_mapped = [
        f"metadata_extensions.opengeo.{field}"
        for field in (
            "contacts",
            "referenceSystems",
            "distributions",
            "quality",
            "lineage",
            "acquisition",
        )
        if catalog.get(field)
        and (field != "acquisition" or acquisition_emitted)
        and (field != "distributions" or bool(distribution_blocks))
    ]
    iso_catalog_unmapped = [
        f"metadata_extensions.opengeo.{field}"
        for field in ("updateFrequency", "sensitivity", "funding")
        if catalog.get(field)
    ]
    if graph_blocks:
        iso_catalog_mapped.append("metadata_extensions.opengeo.isoDistributionGroups")
    iso_catalog_mapped.extend(quality_mapped)
    iso_catalog_unmapped.extend(quality_unmapped)
    iso_catalog_mapped.extend(distribution_mapped)
    iso_catalog_unmapped.extend(distribution_unmapped)
    iso_catalog_mapped.extend(acquisition_context_mapped)
    iso_catalog_unmapped.extend(acquisition_context_unmapped)
    if isinstance(acquisition, dict):
        for index, value in enumerate(cast(list[dict[str, Any]], acquisition.get("events", []))):
            if value["identifier"] not in emitted_events:
                iso_catalog_unmapped.append(
                    f"metadata_extensions.opengeo.acquisition.events[{index}][unreferenced]"
                )
        for index, value in enumerate(
            cast(list[dict[str, Any]], acquisition.get("platformPasses", []))
        ):
            if value["identifier"] not in emitted_platform_passes:
                iso_catalog_unmapped.append(
                    f"metadata_extensions.opengeo.acquisition.platformPasses[{index}][unreferenced]"
                )
                if "extent" in value:
                    iso_catalog_unmapped.append(
                        f"metadata_extensions.opengeo.acquisition.platformPasses[{index}].extent"
                    )
    for index, value in enumerate(distributions):
        for field in (
            "identifier",
            "mediaType",
            "byteSize",
            "checksumSha256",
            "license",
        ):
            if value.get(field) is not None:
                iso_catalog_unmapped.append(
                    f"metadata_extensions.opengeo.distributions[{index}].{field}"
                )
    for index, value in enumerate(quality):
        if value.get("unit") is not None and (
            isinstance(value["result"], str | bool)
            or not _iso_quality_unit_label_supported(value["unit"])
        ):
            iso_catalog_unmapped.append(f"metadata_extensions.opengeo.quality[{index}].unit")
    document_text = ET.tostring(root, encoding="unicode", xml_declaration=True)
    result = {
        "target": "iso_19115_3",
        "targetVersion": "ISO 19115-3:2023",
        "mediaType": "application/xml",
        "status": "mapped_with_explicit_losses",
        "document": None,
        "documentText": document_text,
        "report": {
            "mapped": [
                "resource_id",
                "title",
                "abstract",
                "language",
                "license",
                "attribution",
                "keywords",
                "spatial_extent",
                "temporal_extent",
                "updated_at",
                *(
                    [
                        "language.region->defaultLocale.CountryCode",
                        "language.case->ISO_lowercase_language_uppercase_country",
                    ]
                    if primary_country
                    else []
                ),
                *mapped_translations,
                *iso_catalog_mapped,
            ],
            "defaulted": (
                [
                    "defaultLocale.characterEncoding=utf8",
                    "contact=attribution",
                    "contact.role=pointOfContact",
                ]
                if contact_defaulted
                else ["defaultLocale.characterEncoding=utf8", "contact.role=pointOfContact"]
            ),
            "preservedExtensions": sorted(set(resource.metadata_extensions) - {"opengeo"}),
            "unmapped": [
                "content",
                "provenance",
                "relationships",
                *([] if native_translations else ["translations"]),
                *unmapped_translations,
                *iso_catalog_unmapped,
            ],
            "schemaValidated": False,
            "schematronValidated": False,
            "conformanceClaimed": False,
        },
    }
    if quality_id_collisions:
        result["status"] = "not_exportable_xml_id_collision"
        result["documentText"] = None
        result["report"]["mapped"] = []
        result["report"]["warnings"] = [
            (
                "An exact graph or quality report ID collides with another emitted XML ID. "
                if graph_groups
                else "An exact quality report ID collides with another emitted XML ID. "
            )
            + "No document is exported; native metadata is unchanged."
        ]
    if (
        quality_reports
        and len(json.dumps(result["report"], ensure_ascii=False).encode("utf-8")) > 16_384
    ):
        omit_quality_blocks("report-size-limit")
        prefix = "metadata_extensions.opengeo.qualityReports"
        result["report"]["mapped"] = [
            path for path in result["report"]["mapped"] if not path.startswith(prefix)
        ]
        result["report"]["unmapped"] = [
            path for path in result["report"]["unmapped"] if not path.startswith(prefix)
        ] + [f"{prefix}[{index}][report-size-limit]" for index in range(len(quality_reports))]
        if result["documentText"] is not None:
            result["documentText"] = ET.tostring(root, encoding="unicode", xml_declaration=True)
    if context_size_blocked:
        result["status"] = "not_exportable_size_limit"
        result["documentText"] = None
        result["report"]["mapped"] = []
        result["report"]["warnings"] = [
            "The document exceeds the 49152-byte import limit after omitting acquisition "
            "and distribution context. Native metadata is unchanged."
        ]
        result["report"]["sizeLimitBytes"] = 49_152
        result["report"]["documentBytes"] = xml_size
    if (offline_media_present or graph_groups) and context_size_blocked and xml_size <= 49_152:
        result["report"]["warnings"] = [
            "The ISO document exceeds the 2000-node or 32-level source limit after "
            "omitting optional context. Native metadata is unchanged."
        ]
        result["report"]["nodeLimit"] = 2000
        result["report"]["depthLimit"] = 32
    if (
        graph_groups
        and len(json.dumps(result["report"], ensure_ascii=False).encode("utf-8")) > 16_384
    ):
        omit_graph_groups("report-size-limit")
        graph_prefix = "metadata_extensions.opengeo.isoDistributionGroups"
        result["report"]["mapped"] = [
            path for path in result["report"]["mapped"] if not path.startswith(graph_prefix)
        ]
        result["report"]["unmapped"] = [
            path for path in result["report"]["unmapped"] if not path.startswith(graph_prefix)
        ] + [f"{graph_prefix}[{index}][report-size-limit]" for index in range(len(graph_groups))]
        if result["documentText"] is not None:
            result["documentText"] = ET.tostring(root, encoding="unicode", xml_declaration=True)
    if (distributions or quality_reports or graph_groups) and len(
        json.dumps(result["report"], ensure_ascii=False).encode("utf-8")
    ) > 16_384:
        result["status"] = "not_exportable_size_limit"
        result["documentText"] = None
        result["report"]["mapped"] = []
        # An omitted whole array is one explicit loss; keep the native array intact.
        result["report"]["unmapped"] = [
            path
            for path in result["report"]["unmapped"]
            if not path.startswith("metadata_extensions.opengeo.distributions")
        ] + ["metadata_extensions.opengeo.distributions[report-size-limit]"]
        result["report"]["warnings"] = [
            "The ISO mapping report exceeds 16384 UTF-8 bytes. "
            "No ISO document is exported; all native metadata is unchanged."
        ]
        result["report"]["reportSizeLimitBytes"] = 16_384
    return result


def _not_applicable_export(
    target: MetadataExportTarget, target_version: str, media_type: str, resource: Any
) -> dict[str, Any]:
    return {
        "target": target,
        "targetVersion": target_version,
        "mediaType": media_type,
        "status": "not_applicable",
        "document": None,
        "documentText": None,
        "report": {
            "mapped": [],
            "defaulted": [],
            "preservedExtensions": sorted(resource.metadata_extensions),
            "unmapped": ["resource_kind"],
        },
    }


def _dcat_distribution(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"@type": "dcat:Distribution"}
    fields = {
        "identifier": "dct:identifier",
        "title": "dct:title",
        "accessUrl": "dcat:accessURL",
        "downloadUrl": "dcat:downloadURL",
        "mediaType": "dcat:mediaType",
        "format": "dct:format",
        "license": "dct:license",
    }
    for source, target in fields.items():
        if source in value:
            result[target] = value[source]
    if "byteSize" in value:
        result["dcat:byteSize"] = {
            "@value": value["byteSize"],
            "@type": "xsd:nonNegativeInteger",
        }
    if "checksumSha256" in value:
        result["spdx:checksum"] = {
            "@type": "spdx:Checksum",
            "spdx:algorithm": {"@id": "spdx:checksumAlgorithm_sha256"},
            "spdx:checksumValue": value["checksumSha256"],
        }
    return result


def _dcat_quality_measurement(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "@type": "dqv:QualityMeasurement",
        "dqv:isMeasurementOf": value["measure"],
        "dqv:value": value["result"],
    }
    if "unit" in value:
        result["sdmx-attribute:unitMeasure"] = value["unit"]
    if "description" in value:
        result["dct:description"] = value["description"]
    return result


def _geodcat_catalog_shapes(document: dict[str, Any]) -> None:
    def values(name: str) -> list[Any]:
        value = document.get(name, [])
        return value if isinstance(value, list) else [value]

    def concept(value: Any, class_name: str, category: str) -> dict[str, Any]:
        label = str(value)
        return {
            "@id": f"urn:opengeo:{category}:{sha256(label.encode()).hexdigest()[:16]}",
            "@type": class_name,
            "rdfs:label": label,
            "skos:prefLabel": label,
        }

    for agent in values("dcat:contactPoint"):
        if not isinstance(agent, dict):
            continue
        agent["@type"] = ["vcard:Kind", "foaf:Agent"]
        agent["foaf:name"] = agent.get("vcard:organization-name") or agent.get("vcard:fn")
        email = agent.get("vcard:hasEmail")
        if isinstance(email, dict):
            email["@type"] = "vcard:Email"

    provenance = document.get("dct:provenance")
    if provenance is not None:
        document["dct:provenance"] = {
            "@type": "dct:ProvenanceStatement",
            "rdfs:label": provenance,
        }
    frequency = document.get("dct:accrualPeriodicity")
    if frequency is not None:
        document["dct:accrualPeriodicity"] = concept(frequency, "dct:Frequency", "frequency")
    access_rights = document.get("dct:accessRights")
    if access_rights is not None:
        document["dct:accessRights"] = concept(
            access_rights, "dct:RightsStatement", "access-rights"
        )

    for distribution in values("dcat:distribution"):
        if not isinstance(distribution, dict):
            continue
        if "dcat:accessURL" not in distribution and "dcat:downloadURL" in distribution:
            distribution["dcat:accessURL"] = distribution["dcat:downloadURL"]
        for field in ("dcat:accessURL", "dcat:downloadURL"):
            value = distribution.get(field)
            if isinstance(value, str):
                distribution[field] = {"@id": value}
        media_type = distribution.get("dcat:mediaType")
        if media_type is not None:
            distribution["dcat:mediaType"] = concept(media_type, "dct:MediaType", "media-type")
        format_value = distribution.get("dct:format")
        if format_value is not None:
            distribution["dct:format"] = concept(format_value, "dct:MediaTypeOrExtent", "format")
        license_value = distribution.get("dct:license")
        if license_value is not None:
            distribution["dct:license"] = concept(license_value, "dct:LicenseDocument", "license")
        checksum = distribution.get("spdx:checksum")
        if isinstance(checksum, dict):
            algorithm = checksum.get("spdx:algorithm")
            if isinstance(algorithm, dict):
                algorithm["@type"] = "spdx:ChecksumAlgorithm"
            checksum_value = checksum.get("spdx:checksumValue")
            if isinstance(checksum_value, str):
                checksum["spdx:checksumValue"] = {
                    "@value": checksum_value,
                    "@type": "xsd:hexBinary",
                }

    for measurement in values("dqv:hasQualityMeasurement"):
        if not isinstance(measurement, dict):
            continue
        measure = measurement.get("dqv:isMeasurementOf")
        if measure is not None:
            measurement["dqv:isMeasurementOf"] = concept(measure, "dqv:Metric", "quality")
        unit = measurement.get("sdmx-attribute:unitMeasure")
        if unit is not None:
            measurement["sdmx-attribute:unitMeasure"] = concept(unit, "skos:Concept", "unit")


def _schema_agent(value: dict[str, str]) -> dict[str, Any]:
    agent: dict[str, Any] = {
        "@type": "Organization" if value.get("organization") else "Person",
        "name": value.get("organization") or value.get("name"),
    }
    if value.get("organization") and value.get("name"):
        agent["contactPoint"] = {
            "@type": "ContactPoint",
            "name": value["name"],
        }
        if value.get("email"):
            agent["contactPoint"]["email"] = value["email"]
    elif value.get("email"):
        agent["email"] = value["email"]
    if value.get("identifier"):
        agent["identifier"] = value["identifier"]
    return agent


def _schema_distribution(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"@type": "DataDownload"}
    fields = {
        "identifier": "identifier",
        "title": "name",
        "accessUrl": "url",
        "downloadUrl": "contentUrl",
        "mediaType": "encodingFormat",
        "byteSize": "contentSize",
        "license": "license",
    }
    for source, target in fields.items():
        if source in value:
            result[target] = value[source]
    if "format" in value and "encodingFormat" not in result:
        result["encodingFormat"] = value["format"]
    if "checksumSha256" in value:
        result["sha256"] = value["checksumSha256"]
    return result


def _temporal_interval(start: datetime | None, end: datetime | None) -> str | None:
    if start is None and end is None:
        return None
    return f"{start.isoformat() if start else '..'}/{end.isoformat() if end else '..'}"


class PostgresMetadataProfileRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[MetadataResult]],
    ) -> MetadataResult:
        try:
            return await self._executor.run(context, operation)
        except TenantDatabaseConflict as error:
            raise MetadataConflict("metadata_profile_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise MetadataStoreUnavailable("metadata profile operation failed") from error

    async def list_profiles(self, context: TenantContext) -> list[MetadataProfile]:
        async def operation(transaction: TenantTransaction) -> list[MetadataProfile]:
            await self._authorize(transaction, context, Action.METADATA_PROFILE_READ)
            rows = await transaction.fetch_all(
                f"""{self._select()}
                WHERE profile.organization_id = %s
                ORDER BY lower(profile.title), profile.id
                """,
                (context.organization_id,),
            )
            return [self._profile(row) for row in rows]

        return cast(list[MetadataProfile], await self._run(context, operation))

    async def get_profile(self, context: TenantContext, profile_id: UUID) -> MetadataProfile:
        async def operation(transaction: TenantTransaction) -> MetadataProfile:
            await self._authorize(transaction, context, Action.METADATA_PROFILE_READ)
            return await self._load(transaction, context, profile_id)

        return cast(MetadataProfile, await self._run(context, operation))

    async def create_profile(
        self, context: TenantContext, draft: MetadataProfileDraft, request_id: str
    ) -> MetadataProfile:
        self._verify_checksum(draft.definition, draft.checksum_sha256)
        profile_id = uuid4()
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> MetadataProfile:
            await self._authorize(transaction, context, Action.METADATA_PROFILE_MANAGE)
            await transaction.execute(
                """
                INSERT INTO app.metadata_profiles
                  (id, organization_id, slug, title, description, current_version_id,
                   created_by, updated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    profile_id,
                    context.organization_id,
                    draft.slug,
                    draft.title,
                    draft.description,
                    version_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            await self._insert_version(
                transaction,
                context,
                profile_id,
                version_id,
                1,
                draft.definition,
                draft.checksum_sha256,
                None,
            )
            await self._record_event(
                transaction,
                context,
                "metadata.profile.created",
                profile_id,
                request_id,
                {"slug": draft.slug, "version": 1},
            )
            return await self._load(transaction, context, profile_id)

        return cast(MetadataProfile, await self._run(context, operation))

    async def update_profile(
        self,
        context: TenantContext,
        profile_id: UUID,
        update: MetadataProfileUpdate,
        request_id: str,
    ) -> MetadataProfile:
        self._verify_checksum(update.definition, update.checksum_sha256)
        version_id = uuid4()

        async def operation(transaction: TenantTransaction) -> MetadataProfile:
            await self._authorize(transaction, context, Action.METADATA_PROFILE_MANAGE)
            row = await transaction.fetch_one(
                """
                SELECT version.version_number
                FROM app.metadata_profiles profile
                JOIN app.metadata_profile_versions version
                  ON version.organization_id = profile.organization_id
                 AND version.profile_id = profile.id
                 AND version.id = profile.current_version_id
                WHERE profile.organization_id = %s AND profile.id = %s
                FOR UPDATE OF profile
                """,
                (context.organization_id, profile_id),
            )
            if row is None:
                raise MetadataNotFound("metadata_profile")
            current = cast(int, row[0])
            if current != update.expected_version:
                raise MetadataConflict("metadata_profile_version_conflict", current_version=current)
            next_version = current + 1
            await self._insert_version(
                transaction,
                context,
                profile_id,
                version_id,
                next_version,
                update.definition,
                update.checksum_sha256,
                update.change_message,
            )
            await transaction.execute(
                """
                UPDATE app.metadata_profiles
                SET title = %s, description = %s, current_version_id = %s, updated_by = %s
                WHERE organization_id = %s AND id = %s
                """,
                (
                    update.title,
                    update.description,
                    version_id,
                    context.user_id,
                    context.organization_id,
                    profile_id,
                ),
            )
            await self._record_event(
                transaction,
                context,
                "metadata.profile.version.created",
                profile_id,
                request_id,
                {"version": next_version},
            )
            return await self._load(transaction, context, profile_id)

        return cast(MetadataProfile, await self._run(context, operation))

    @staticmethod
    async def _insert_version(
        transaction: TenantTransaction,
        context: TenantContext,
        profile_id: UUID,
        version_id: UUID,
        version_number: int,
        definition: dict[str, Any],
        checksum_sha256: str,
        change_message: str | None,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.metadata_profile_versions
              (id, organization_id, profile_id, version_number, definition,
               checksum_sha256, change_message, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                version_id,
                context.organization_id,
                profile_id,
                version_number,
                Jsonb(definition),
                checksum_sha256,
                change_message,
                context.user_id,
            ),
        )

    async def _load(
        self, transaction: TenantTransaction, context: TenantContext, profile_id: UUID
    ) -> MetadataProfile:
        row = await transaction.fetch_one(
            f"""{self._select()}
            WHERE profile.organization_id = %s AND profile.id = %s
            """,
            (context.organization_id, profile_id),
        )
        if row is None:
            raise MetadataNotFound("metadata_profile")
        return self._profile(row)

    @staticmethod
    def _select() -> str:
        return """
            SELECT profile.id, profile.slug, profile.title, profile.description,
                   version.version_number, version.definition, version.checksum_sha256,
                   version.change_message, profile.created_by, version.created_by,
                   profile.created_at, profile.updated_at, version.created_at
            FROM app.metadata_profiles profile
            JOIN app.metadata_profile_versions version
              ON version.organization_id = profile.organization_id
             AND version.profile_id = profile.id
             AND version.id = profile.current_version_id
        """

    @staticmethod
    def _profile(row: tuple[Any, ...]) -> MetadataProfile:
        return MetadataProfile(
            profile_id=cast(UUID, row[0]),
            slug=cast(str, row[1]),
            title=cast(str, row[2]),
            description=cast(str | None, row[3]),
            version_number=cast(int, row[4]),
            definition=cast(dict[str, Any], row[5]),
            checksum_sha256=cast(str, row[6]),
            change_message=cast(str | None, row[7]),
            created_by=cast(UUID, row[8]),
            version_created_by=cast(UUID, row[9]),
            created_at=cast(datetime, row[10]),
            updated_at=cast(datetime, row[11]),
            version_created_at=cast(datetime, row[12]),
        )

    @staticmethod
    async def _authorize(
        transaction: TenantTransaction, context: TenantContext, action: Action
    ) -> None:
        row = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (context.organization_id, context.user_id),
        )
        if row is None:
            raise MetadataAccessDenied("action forbidden")
        try:
            authorize(action, Roles(organization=cast(Any, row[0])))
        except AuthorizationDenied as error:
            raise MetadataAccessDenied("action forbidden") from error

    @staticmethod
    def _verify_checksum(definition: dict[str, Any], checksum_sha256: str) -> None:
        if metadata_definition_checksum(definition) != checksum_sha256:
            raise MetadataConflict("metadata_profile_checksum_mismatch")

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        event_type: str,
        profile_id: UUID,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, event_type, resource_type,
               resource_id, request_id, payload)
            VALUES (%s, %s, %s, 'metadata_profile', %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                event_type,
                profile_id,
                request_id,
                Jsonb(payload),
            ),
        )
