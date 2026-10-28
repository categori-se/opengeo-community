import json
import re
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action, AuthorizationDenied, Roles, authorize
from opengeo_api.metadata_catalog import catalog_metadata
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
        for field in ("referenceSystems", "funding", "acquisition")
        if catalog.get(field)
    ]
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
            "unmapped": ["content", *opengeo_unmapped]
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
            "unmapped": ["content", "provenance", *catalog_unmapped]
            + (["translations.keywords"] if translations else []),
            "conformanceClaimed": False,
        },
    }


def export_datacite_4_7(resource: Any) -> dict[str, Any]:
    summary = resource.summary
    if summary.kind != "dataset":
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
    catalog_publisher = next(
        (
            contact.get("organization") or contact.get("name")
            for contact in cast(list[dict[str, str]], catalog.get("contacts", []))
            if contact.get("role") == "publisher"
        ),
        None,
    )
    publisher_value = datacite.get("publisher") or catalog_publisher or summary.attribution
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
        "types": {"resourceTypeGeneral": "Dataset"},
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
    return {
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
            ],
            "defaulted": (
                ["publicationYear=created_at.year"] if "publicationYear" not in datacite else []
            ),
            "multilingualLanguages": sorted({summary.language.lower(), *translations}),
            "preservedExtensions": sorted(resource.metadata_extensions),
            "unmapped": [
                "content",
                "provenance",
                *(
                    ["metadata_extensions.opengeo.acquisition"]
                    if catalog.get("acquisition")
                    else []
                ),
            ],
            "conformanceClaimed": False,
        },
    }


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

    titles_element = child(root, "titles")
    for value in cast(list[dict[str, Any]], attributes["titles"]):
        title = child(titles_element, "title", value["title"])
        if isinstance(value.get("lang"), str):
            title.set(f"{{{xml}}}lang", value["lang"])

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
    resource_type = child(root, "resourceType", attributes.get("types", {}).get("resourceType"))
    resource_type.set("resourceTypeGeneral", "Dataset")

    subjects = cast(list[dict[str, Any]], attributes.get("subjects", []))
    if subjects:
        subjects_element = child(root, "subjects")
        for value in subjects:
            subject = child(subjects_element, "subject", value["subject"])
            if isinstance(value.get("lang"), str):
                subject.set(f"{{{xml}}}lang", value["lang"])

    dates = cast(list[dict[str, Any]], attributes.get("dates", []))
    if dates:
        dates_element = child(root, "dates")
        for value in dates:
            date = child(dates_element, "date", value["date"])
            date.set("dateType", value["dateType"])
    if attributes.get("language"):
        child(root, "language", attributes["language"])

    related_identifiers = cast(list[dict[str, Any]], attributes.get("relatedIdentifiers", []))
    if related_identifiers:
        related_element = child(root, "relatedIdentifiers")
        for value in related_identifiers:
            related = child(related_element, "relatedIdentifier", value["relatedIdentifier"])
            related.set("relatedIdentifierType", value["relatedIdentifierType"])
            related.set("relationType", value["relationType"])

    if attributes.get("version"):
        child(root, "version", attributes["version"])
    rights_values = cast(list[dict[str, Any]], attributes.get("rightsList", []))
    if rights_values:
        rights_element = child(root, "rightsList")
        for value in rights_values:
            rights = child(rights_element, "rights", value["rights"])
            if isinstance(value.get("rightsUri"), str):
                rights.set("rightsURI", value["rightsUri"])
            if isinstance(value.get("rightsIdentifier"), str):
                rights.set("rightsIdentifier", value["rightsIdentifier"])

    descriptions = cast(list[dict[str, Any]], attributes.get("descriptions", []))
    if descriptions:
        descriptions_element = child(root, "descriptions")
        for value in descriptions:
            description = child(descriptions_element, "description", value["description"])
            description.set("descriptionType", value["descriptionType"])
            if isinstance(value.get("lang"), str):
                description.set(f"{{{xml}}}lang", value["lang"])

    geo_locations = cast(list[dict[str, Any]], attributes.get("geoLocations", []))
    if geo_locations:
        locations_element = child(root, "geoLocations")
        for value in geo_locations:
            location = child(locations_element, "geoLocation")
            box_value = value.get("geoLocationBox")
            if isinstance(box_value, dict):
                box = child(location, "geoLocationBox")
                for bound in (
                    "westBoundLongitude",
                    "eastBoundLongitude",
                    "southBoundLatitude",
                    "northBoundLatitude",
                ):
                    child(box, bound, box_value[bound])

    funding_references = cast(list[dict[str, str]], attributes.get("fundingReferences", []))
    if funding_references:
        funding_element = child(root, "fundingReferences")
        for value in funding_references:
            funding_reference = child(funding_element, "fundingReference")
            child(funding_reference, "funderName", value["funderName"])
            if value.get("funderIdentifier"):
                funder_identifier = child(
                    funding_reference,
                    "funderIdentifier",
                    value["funderIdentifier"],
                )
                funder_identifier.set("funderIdentifierType", value["funderIdentifierType"])
                if value.get("schemeUri"):
                    funder_identifier.set("schemeURI", value["schemeUri"])
            if value.get("awardNumber"):
                award_number = child(funding_reference, "awardNumber", value["awardNumber"])
                if value.get("awardUri"):
                    award_number.set("awardURI", value["awardUri"])
            if value.get("awardTitle"):
                child(funding_reference, "awardTitle", value["awardTitle"])

    result = dict(json_result)
    result.update(
        {
            "target": "datacite_4_7_xml",
            "mediaType": "application/xml",
            "document": None,
            "documentText": ET.tostring(root, encoding="unicode", xml_declaration=True),
        }
    )
    report = dict(cast(dict[str, Any], json_result["report"]))
    report["normativeRepresentation"] = "DataCite Metadata Schema 4.7 XML"
    report["schemaValidated"] = False
    result["report"] = report
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
    if missing:
        result = _not_applicable_export(
            "iso_19115_3", "ISO 19115-3:2023", "application/xml", resource
        )
        result["status"] = "not_exportable_missing_required_metadata"
        result["report"]["missingRequired"] = missing
        result["report"]["schemaValidated"] = False
        result["report"]["schematronValidated"] = False
        result["report"]["conformanceClaimed"] = False
        return result
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
    language_code = child(language, "lan", "LanguageCode", summary.language.lower())
    language_code.set(
        "codeList", "https://schemas.isotc211.org/19115/resources/Codelist/lan/LanguageCode.xml"
    )
    language_code.set("codeListValue", summary.language.lower())
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
    if distributions:
        distribution_info = child(root, "mdb", "distributionInfo")
        distribution_value = child(distribution_info, "mrd", "MD_Distribution")
        for value in distributions:
            transfer_options = child(distribution_value, "mrd", "transferOptions")
            transfer_value = child(transfer_options, "mrd", "MD_DigitalTransferOptions")
            online = child(transfer_value, "mrd", "onLine")
            online_value = child(online, "cit", "CI_OnlineResource")
            is_download = bool(value.get("downloadUrl"))
            linkage_value = value.get("downloadUrl") or value["accessUrl"]
            child(
                child(online_value, "cit", "linkage"),
                "gco",
                "CharacterString",
                linkage_value,
            )
            if value.get("format"):
                child(
                    child(online_value, "cit", "protocol"),
                    "gco",
                    "CharacterString",
                    value["format"],
                )
            if value.get("title"):
                child(
                    child(online_value, "cit", "name"),
                    "gco",
                    "CharacterString",
                    value["title"],
                )
            function = child(online_value, "cit", "function")
            function_value = "download" if is_download else "information"
            function_code = child(function, "cit", "CI_OnLineFunctionCode", function_value)
            function_code.set(
                "codeList",
                "https://schemas.isotc211.org/resources/codelists/codelists.xml#CI_OnLineFunctionCode",
            )
            function_code.set("codeListValue", function_value)
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
        for value in quality:
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
    if isinstance(acquisition, dict):
        acquisition_info = child(root, "mdb", "acquisitionInformation")
        acquisition_value = child(acquisition_info, "mac", "MI_AcquisitionInformation")
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
        for index, value in enumerate(
            cast(list[dict[str, Any]], acquisition.get("plans", [])), start=1
        ):
            plan_info = child(acquisition_value, "mac", "acquisitionPlan")
            plan = child(plan_info, "mac", "MI_Plan")
            plan.set("id", f"opengeo-plan-{index}")
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
        for value in objective_records:
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
        for value in requirement_records:
            requirement_info = child(acquisition_value, "mac", "acquisitionRequirement")
            requirement = child(requirement_info, "mac", "MI_Requirement")
            requirement.set("id", requirement_xml_ids[value["identifier"]])
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
    ]
    iso_catalog_unmapped = [
        f"metadata_extensions.opengeo.{field}"
        for field in ("updateFrequency", "sensitivity", "funding")
        if catalog.get(field)
    ]
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
        if value.get("downloadUrl") and value.get("accessUrl"):
            iso_catalog_unmapped.append(
                f"metadata_extensions.opengeo.distributions[{index}].accessUrl"
            )
    for index, value in enumerate(quality):
        if value.get("unit") is not None:
            iso_catalog_unmapped.append(f"metadata_extensions.opengeo.quality[{index}].unit")
    document_text = ET.tostring(root, encoding="unicode", xml_declaration=True)
    return {
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
