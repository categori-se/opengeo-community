import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from hashlib import sha256
from typing import Any, cast
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.metadata_catalog import CatalogMetadataInvalid, validate_catalog_extensions
from opengeo_api.resources import (
    MetadataResourceImportPlan,
    MetadataSourceFormat,
    MetadataSourceValue,
    ResourceDraft,
    ResourceKind,
    ResourceMetadata,
    ResourceVisibility,
)

DCAT_3_VERSION = "W3C Recommendation 2024-08-22"
STAC_1_1_VERSION = "1.1.0"
ISO_19115_3_VERSION = "ISO 19115-3:2023"
SCHEMA_ORG_VERSION = "30.0"
DATACITE_VERSION = "4.7"
GEODCAT_AP_VERSION = "3.1.0"
MAX_SOURCE_BYTES = 49_152
_LANGUAGE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_DOI = re.compile(r"^10\.[0-9]{4,9}/\S+$", re.IGNORECASE)
_NAMESPACE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$")
_SENSITIVE_NAME = re.compile(
    r"(?:^|[_-])(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|"
    r"password|private[_-]?key|secret|session|signature|x[_-]?amz[_-].*)(?:$|[_-])",
    re.IGNORECASE,
)
_DCAT_CONTEXTS = {
    "https://www.w3.org/ns/dcat.jsonld",
    "https://www.w3.org/ns/dcat3.jsonld",
}
_SCHEMA_ORG_CONTEXTS = {"https://schema.org", "https://schema.org/"}
_GEODCAT_NAMESPACE = "http://data.europa.eu/930/"
_WKT_POLYGON = re.compile(r"^\s*POLYGON\s*\(\((.*)\)\)\s*$", re.IGNORECASE)


class MetadataImportInvalid(ValueError):
    pass


def metadata_source_checksum(document: MetadataSourceValue) -> str:
    source = (
        document.encode("utf-8") if isinstance(document, str) else canonical_json_bytes(document)
    )
    return sha256(source).hexdigest()


def assert_safe_metadata_source(document: MetadataSourceValue) -> None:
    if isinstance(document, str):
        _parse_safe_iso_xml(document)
        return
    nodes = 0

    def visit(value: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 10_000:
            raise MetadataImportInvalid("metadata source document has too many values")
        if depth > 32:
            raise MetadataImportInvalid("metadata source document is too deeply nested")
        if isinstance(value, dict):
            for key, child in value.items():
                if not isinstance(key, str) or not 1 <= len(key) <= 200:
                    raise MetadataImportInvalid("metadata source keys must be bounded strings")
                if _SENSITIVE_NAME.search(key):
                    raise MetadataImportInvalid("metadata source contains credential-like keys")
                visit(child, depth + 1)
        elif isinstance(value, list):
            if len(value) > 2_000:
                raise MetadataImportInvalid("metadata source arrays are too large")
            for child in value:
                visit(child, depth + 1)
        elif isinstance(value, str):
            if len(value) > 16_384:
                raise MetadataImportInvalid("metadata source strings are too large")
            _reject_sensitive_url(value)
        elif value is not None and not isinstance(value, bool | int | float):
            raise MetadataImportInvalid("metadata source contains unsupported JSON values")
        elif isinstance(value, float) and not math.isfinite(value):
            raise MetadataImportInvalid("metadata source numbers must be finite")

    visit(document, 0)
    try:
        encoded = canonical_json_bytes(document)
    except UnicodeEncodeError as error:
        raise MetadataImportInvalid("metadata source contains invalid Unicode") from error
    if not 2 <= len(encoded) <= MAX_SOURCE_BYTES:
        raise MetadataImportInvalid("metadata source document exceeds 49152 canonical bytes")


def build_metadata_import_plan(
    source_format: MetadataSourceFormat,
    source_namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: MetadataSourceValue,
    source_sha256: str,
    *,
    managed_profile_id: UUID | None = None,
    managed_profile_version: int | None = None,
    metadata_profile: str = "opengeo.core.v1",
) -> MetadataResourceImportPlan:
    assert_safe_metadata_source(document)
    checksum = metadata_source_checksum(document)
    if checksum != source_sha256:
        raise MetadataImportInvalid(
            "metadata source checksum does not match its exact source representation"
        )
    if not _NAMESPACE.fullmatch(source_namespace):
        raise MetadataImportInvalid("metadata source namespace is invalid")
    if (managed_profile_id is None) != (managed_profile_version is None):
        raise MetadataImportInvalid("managed profile id and version are required together")
    if source_format == "iso_19115_3":
        if not isinstance(document, str):
            raise MetadataImportInvalid("ISO 19115-3 source must be an XML string")
        return _iso_plan(
            source_namespace,
            slug,
            visibility,
            document,
            checksum,
            managed_profile_id,
            managed_profile_version,
            metadata_profile,
        )
    if not isinstance(document, dict):
        raise MetadataImportInvalid("JSON metadata source must be an object")
    if source_format == "dcat_3":
        return _dcat_plan(
            source_namespace,
            slug,
            visibility,
            document,
            checksum,
            managed_profile_id,
            managed_profile_version,
            metadata_profile,
        )
    if source_format == "stac_1_1":
        return _stac_plan(
            source_namespace,
            slug,
            visibility,
            document,
            checksum,
            managed_profile_id,
            managed_profile_version,
            metadata_profile,
        )
    if source_format == "schema_org_dataset":
        return _schema_org_plan(
            source_namespace,
            slug,
            visibility,
            document,
            checksum,
            managed_profile_id,
            managed_profile_version,
            metadata_profile,
        )
    if source_format == "datacite_4_7":
        return _datacite_plan(
            source_namespace,
            slug,
            visibility,
            document,
            checksum,
            managed_profile_id,
            managed_profile_version,
            metadata_profile,
        )
    if source_format == "geodcat_ap_3_1":
        return _geodcat_plan(
            source_namespace,
            slug,
            visibility,
            document,
            checksum,
            managed_profile_id,
            managed_profile_version,
            metadata_profile,
        )
    raise MetadataImportInvalid("metadata source format is unsupported")


def _dcat_plan(
    namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: dict[str, Any],
    checksum: str,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
    extensions: dict[str, Any] | None = None,
    source_format: MetadataSourceFormat = "dcat_3",
    source_version: str = DCAT_3_VERSION,
    known_extensions: set[str] | None = None,
) -> MetadataResourceImportPlan:
    context = document.get("@context")
    if not _has_dcat_context(context):
        raise MetadataImportInvalid("DCAT source must declare the DCAT and DCT contexts")
    if source_format == "geodcat_ap_3_1" and not _has_geodcat_context(context):
        raise MetadataImportInvalid("GeoDCAT-AP source must declare the 930 namespace")
    source_type = document.get("@type")
    kinds: dict[str, ResourceKind] = {
        "dcat:Dataset": "dataset",
        "dcat:DataService": "service",
        "dcat:Resource": "document",
    }
    if source_type not in kinds:
        raise MetadataImportInvalid("DCAT source type is not supported")
    identifier_field = "dct:identifier" if "dct:identifier" in document else "@id"
    identifier = _bounded_string(document.get(identifier_field), 1, 500, "DCAT identifier")
    title_values = _dcat_localized_values(document.get("dct:title"), 300, "DCAT title")
    declared_languages = _dcat_languages(document.get("dct:language"))
    language = (
        title_values[0][1] or (declared_languages[0] if declared_languages else "en")
    ).lower()
    primary_titles = [value for value, item_language in title_values if item_language == language]
    untagged_titles = [value for value, item_language in title_values if item_language is None]
    title = (primary_titles or untagged_titles or [title_values[0][0]])[0]
    translations: dict[str, dict[str, Any]] = {
        item_language.lower(): {"title": value}
        for value, item_language in title_values
        if item_language is not None and item_language.lower() != language
    }
    description_values = _dcat_localized_values(
        document.get("dct:description"), 8_000, "DCAT description", optional=True
    )
    rights_values = _dcat_localized_values(
        document.get("dct:rights"), 2_000, "DCAT rights", optional=True
    )
    keyword_values = _dcat_localized_keywords(document.get("dcat:keyword"))
    abstract = _primary_localized_value(description_values, language)
    license_value = _optional_string(document.get("dct:license"), 1_000, "DCAT license")
    attribution = _primary_localized_value(rights_values, language)
    keywords = tuple(
        value
        for value, item_language in keyword_values
        if item_language is None or item_language == language
    )
    multilingual_unmapped: list[str] = []
    for source_field, target_field, localized_values in (
        ("dct:description", "abstract", description_values),
        ("dct:rights", "attribution", rights_values),
    ):
        for value, item_language in localized_values:
            if item_language is None or item_language == language:
                continue
            translation = translations.get(item_language)
            if translation is None:
                multilingual_unmapped.append(f"{source_field}[{item_language}]")
            else:
                translation[target_field] = value
    keywords_by_language: dict[str, list[str]] = {}
    for value, item_language in keyword_values:
        if item_language is not None and item_language != language:
            keywords_by_language.setdefault(item_language, []).append(value)
    for item_language, localized_keywords in keywords_by_language.items():
        translation = translations.get(item_language)
        if translation is None:
            multilingual_unmapped.append(f"dcat:keyword[{item_language}]")
        else:
            translation["keywords"] = localized_keywords
    spatial_extent = _dcat_extent(document.get("dct:spatial"))
    temporal_start, temporal_end = _dcat_temporal(document.get("dct:temporal"))
    catalog_extension, catalog_mapped, catalog_derived, catalog_unmapped = _dcat_catalog_extension(
        document
    )
    extensions = dict(extensions or {})
    if catalog_extension:
        extensions["opengeo"] = catalog_extension
    known = {
        "@context",
        "@id",
        "@type",
        "dct:identifier",
        "dct:title",
        "dct:language",
        "dct:description",
        "dct:license",
        "dct:rights",
        "dcat:keyword",
        "dct:spatial",
        "dct:temporal",
        "dcat:contactPoint",
        "dct:creator",
        "dct:publisher",
        "dcat:distribution",
        "dct:provenance",
        "prov:wasDerivedFrom",
        "dct:accrualPeriodicity",
        "dct:accessRights",
        "dqv:hasQualityMeasurement",
    }
    known.update(known_extensions or set())
    unmapped = sorted([*(set(document) - known), *multilingual_unmapped, *catalog_unmapped])
    if identifier_field == "dct:identifier" and "@id" in document:
        unmapped.append("@id")
        unmapped.sort()
    mapped = [
        "@context->dcat_3_context",
        "@type->kind",
        f"{identifier_field}->source_identifier",
        "dct:title->title",
    ]
    mapped.extend(catalog_mapped)
    if "dct:language" in document:
        mapped.append("dct:language->language")
    elif title_values[0][1] is not None:
        mapped.append("dct:title.@language->language")
    if translations:
        mapped.append("language-tagged values->translations")
    if extensions:
        mapped.append("profile-specific fields->metadata_extensions")
    for source, target in (
        ("dct:description", "abstract"),
        ("dct:license", "license"),
        ("dct:rights", "attribution"),
        ("dcat:keyword", "keywords"),
        ("dct:spatial", "spatial_extent"),
        ("dct:temporal", "temporal_extent"),
    ):
        if source in document:
            mapped.append(f"{source}->{target}")
    report = _report(
        source_format,
        mapped,
        ["language=en"] if "dct:language" not in document and title_values[0][1] is None else [],
        unmapped,
        catalog_derived,
    )
    return _plan(
        source_format=source_format,
        source_version=source_version,
        namespace=namespace,
        identifier=identifier,
        checksum=checksum,
        document=document,
        report=report,
        kind=kinds[cast(str, source_type)],
        slug=slug,
        visibility=visibility,
        title=title,
        abstract=abstract,
        language=language,
        license_value=license_value,
        attribution=attribution,
        keywords=keywords,
        translations=translations,
        spatial_extent=spatial_extent,
        temporal_start=temporal_start,
        temporal_end=temporal_end,
        managed_profile_id=managed_profile_id,
        managed_profile_version=managed_profile_version,
        metadata_profile=metadata_profile,
        extensions=extensions or None,
    )


def _stac_plan(
    namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: dict[str, Any],
    checksum: str,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
    extensions: dict[str, Any] | None = None,
) -> MetadataResourceImportPlan:
    if document.get("type") != "Collection" or document.get("stac_version") != STAC_1_1_VERSION:
        raise MetadataImportInvalid("STAC source must be a 1.1.0 Collection")
    identifier = _bounded_string(document.get("id"), 1, 500, "STAC id")
    defaulted: list[str] = []
    if "title" in document:
        title = _bounded_string(document["title"], 1, 300, "STAC title")
    else:
        title = _bounded_string(identifier, 1, 300, "STAC id used as title")
        defaulted.append("title=id")
    abstract = _bounded_string(document.get("description"), 1, 8_000, "STAC description")
    license_value = _bounded_string(document.get("license"), 1, 1_000, "STAC license")
    keywords = _keywords(document.get("keywords", []), "STAC keywords")
    spatial_extent, spatial_derived = _stac_spatial(document.get("extent"))
    temporal_start, temporal_end, temporal_derived = _stac_temporal(document.get("extent"))
    known = {
        "type",
        "stac_version",
        "id",
        "title",
        "description",
        "license",
        "keywords",
        "extent",
    }
    unmapped = sorted(set(document) - known)
    mapped = [
        "type=Collection->kind=dataset",
        "stac_version->source_version",
        "id->source_identifier",
        "description->abstract",
        "license->license",
        "keywords->keywords",
        "extent.spatial->spatial_extent",
        "extent.temporal->temporal_extent",
    ]
    if "title" in document:
        mapped.insert(3, "title->title")
    report = _report(
        "stac_1_1",
        mapped,
        [*defaulted, "language=en"],
        unmapped,
        spatial_derived + temporal_derived,
    )
    return _plan(
        source_format="stac_1_1",
        source_version=STAC_1_1_VERSION,
        namespace=namespace,
        identifier=identifier,
        checksum=checksum,
        document=document,
        report=report,
        kind="dataset",
        slug=slug,
        visibility=visibility,
        title=title,
        abstract=abstract,
        language="en",
        license_value=license_value,
        attribution=None,
        keywords=keywords,
        translations={},
        spatial_extent=spatial_extent,
        temporal_start=temporal_start,
        temporal_end=temporal_end,
        managed_profile_id=managed_profile_id,
        managed_profile_version=managed_profile_version,
        metadata_profile=metadata_profile,
    )


def _schema_org_plan(
    namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: dict[str, Any],
    checksum: str,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
) -> MetadataResourceImportPlan:
    if not _has_schema_org_context(document.get("@context")):
        raise MetadataImportInvalid("schema.org source must declare the schema.org context")
    if document.get("@type") != "Dataset":
        raise MetadataImportInvalid("schema.org source must have @type Dataset")
    identifier = _schema_identifier(document.get("identifier", document.get("@id")))
    title_values = _jsonld_localized_values(document.get("name"), 300, "schema.org name")
    description_values = _jsonld_localized_values(
        document.get("description"), 8_000, "schema.org description", optional=True
    )
    language = _source_primary_language(document.get("inLanguage"), title_values)
    title, abstract, translations, multilingual_unmapped = _localized_metadata(
        title_values,
        description_values,
        [],
        [],
        language,
    )
    raw_keywords = document.get("keywords", [])
    derived: list[str] = []
    if isinstance(raw_keywords, str) and "," in raw_keywords:
        raw_keywords = [part.strip() for part in raw_keywords.split(",") if part.strip()]
        derived.append("comma-delimited keywords split")
    keywords = _keywords(raw_keywords, "schema.org keywords")
    spatial_extent = _schema_spatial(document.get("spatialCoverage"))
    temporal_start, temporal_end = _schema_temporal(document.get("temporalCoverage"))
    license_value = _schema_scalar(document.get("license"), 1_000, "schema.org license")
    attribution = _schema_agent_name(
        document.get("creditText", document.get("publisher")), "schema.org attribution"
    )
    known = {
        "@context",
        "@id",
        "@type",
        "identifier",
        "name",
        "description",
        "inLanguage",
        "license",
        "creditText",
        "keywords",
        "spatialCoverage",
        "temporalCoverage",
        "version",
        "dateCreated",
        "dateModified",
        "creator",
        "publisher",
        "distribution",
        "isBasedOn",
    }
    catalog_extension, catalog_mapped, catalog_derived, catalog_unmapped = (
        _schema_catalog_extension(document)
    )
    extensions: dict[str, Any] = {
        "schema_org": {
            key: document[key]
            for key in ("creator", "publisher", "distribution", "isBasedOn")
            if key in document
        }
    }
    extensions = {key: value for key, value in extensions.items() if value}
    if catalog_extension:
        extensions["opengeo"] = catalog_extension
    mapped = [
        "@type=Dataset->kind=dataset",
        "identifier/@id->source_identifier",
        "name->title",
    ]
    for source, target in (
        ("description", "abstract"),
        ("inLanguage", "language"),
        ("license", "license"),
        ("creditText/publisher", "attribution"),
        ("keywords", "keywords"),
        ("spatialCoverage.geo.box", "spatial_extent"),
        ("temporalCoverage", "temporal_extent"),
    ):
        if source.split("/")[0] in document or (
            source == "creditText/publisher" and "publisher" in document
        ):
            mapped.append(f"{source}->{target}")
    if translations:
        mapped.append("language-tagged name/description->translations")
    if extensions:
        mapped.append("creator/publisher/distribution/isBasedOn->metadata_extensions")
    mapped.extend(catalog_mapped)
    report = _report(
        "schema_org_dataset",
        mapped,
        ["language=en"] if "inLanguage" not in document and title_values[0][1] is None else [],
        sorted([*(set(document) - known), *multilingual_unmapped, *catalog_unmapped]),
        [*derived, *catalog_derived],
    )
    return _plan(
        source_format="schema_org_dataset",
        source_version=SCHEMA_ORG_VERSION,
        namespace=namespace,
        identifier=identifier,
        checksum=checksum,
        document=document,
        report=report,
        kind="dataset",
        slug=slug,
        visibility=visibility,
        title=title,
        abstract=abstract,
        language=language,
        license_value=license_value,
        attribution=attribution,
        keywords=keywords,
        translations=translations,
        spatial_extent=spatial_extent,
        temporal_start=temporal_start,
        temporal_end=temporal_end,
        managed_profile_id=managed_profile_id,
        managed_profile_version=managed_profile_version,
        metadata_profile=metadata_profile,
        extensions=extensions,
    )


def _datacite_plan(
    namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: dict[str, Any],
    checksum: str,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
) -> MetadataResourceImportPlan:
    data = document.get("data")
    if not isinstance(data, dict) or data.get("type") != "dois":
        raise MetadataImportInvalid("DataCite source must contain one data object of type dois")
    attributes = data.get("attributes")
    if not isinstance(attributes, dict):
        raise MetadataImportInvalid("DataCite source attributes must be an object")
    identifier = _bounded_string(
        attributes.get("doi", data.get("id")), 1, 500, "DataCite DOI"
    ).lower()
    if _DOI.fullmatch(identifier) is None:
        raise MetadataImportInvalid("DataCite DOI is invalid")
    if data.get("id") is not None and str(data["id"]).lower() != identifier:
        raise MetadataImportInvalid("DataCite data id must equal its DOI")
    if attributes.get("schemaVersion") not in {
        "http://datacite.org/schema/kernel-4",
        "https://schema.datacite.org/meta/kernel-4/",
    }:
        raise MetadataImportInvalid("DataCite schemaVersion must identify metadata kernel 4")
    titles = attributes.get("titles")
    if not isinstance(titles, list) or not 1 <= len(titles) <= 9:
        raise MetadataImportInvalid("DataCite titles must contain 1 to 9 values")
    title_values = [
        (
            _bounded_string(item.get("title"), 1, 300, "DataCite title"),
            _language(item["lang"]).lower() if "lang" in item else None,
        )
        for item in titles
        if isinstance(item, dict)
    ]
    if len(title_values) != len(titles):
        raise MetadataImportInvalid("DataCite titles must be objects")
    _unique_localized_languages(title_values, "DataCite titles")
    descriptions = attributes.get("descriptions", [])
    if not isinstance(descriptions, list) or len(descriptions) > 9:
        raise MetadataImportInvalid("DataCite descriptions must contain at most 9 values")
    description_values: list[tuple[str, str | None]] = []
    unmapped_descriptions: list[str] = []
    for index, item in enumerate(descriptions):
        if not isinstance(item, dict):
            raise MetadataImportInvalid("DataCite descriptions must be objects")
        if item.get("descriptionType") != "Abstract":
            unmapped_descriptions.append(f"data.attributes.descriptions[{index}]")
            continue
        description_values.append(
            (
                _bounded_string(item.get("description"), 1, 8_000, "DataCite abstract"),
                _language(item["lang"]).lower() if "lang" in item else None,
            )
        )
    _unique_localized_languages(description_values, "DataCite abstracts")
    language = _source_primary_language(attributes.get("language"), title_values)
    title, abstract, translations, multilingual_unmapped = _localized_metadata(
        title_values,
        description_values,
        [],
        [],
        language,
    )
    subjects = attributes.get("subjects", [])
    if not isinstance(subjects, list) or len(subjects) > 64:
        raise MetadataImportInvalid("DataCite subjects must contain at most 64 values")
    keywords = _keywords(
        [
            _bounded_string(item.get("subject"), 1, 100, "DataCite subject")
            if isinstance(item, dict)
            else item
            for item in subjects
        ],
        "DataCite subjects",
    )
    rights = attributes.get("rightsList", [])
    if not isinstance(rights, list) or len(rights) > 20:
        raise MetadataImportInvalid("DataCite rightsList must contain at most 20 values")
    license_value = None
    if rights:
        first_right = rights[0]
        if not isinstance(first_right, dict):
            raise MetadataImportInvalid("DataCite rightsList values must be objects")
        license_value = _optional_string(
            first_right.get("rightsIdentifier")
            or first_right.get("rightsUri")
            or first_right.get("rights"),
            1_000,
            "DataCite rights",
        )
    publisher = _datacite_publisher(attributes.get("publisher"))
    creators = attributes.get("creators")
    if not isinstance(creators, list) or not 1 <= len(creators) <= 100:
        raise MetadataImportInvalid("DataCite creators must contain 1 to 100 values")
    for creator in creators:
        if not isinstance(creator, dict):
            raise MetadataImportInvalid("DataCite creators must be objects")
        _bounded_string(
            creator.get("name") or creator.get("creatorName"),
            1,
            500,
            "DataCite creator name",
        )
    if publisher is None:
        raise MetadataImportInvalid("DataCite publisher is required")
    publication_year = attributes.get("publicationYear")
    if (
        isinstance(publication_year, bool)
        or not isinstance(publication_year, int)
        or not 1000 <= publication_year <= 9999
    ):
        raise MetadataImportInvalid("DataCite publicationYear is invalid")
    spatial_extent = _datacite_spatial(attributes.get("geoLocations", []))
    temporal_start, temporal_end = _datacite_temporal(attributes.get("dates", []))
    resource_type = attributes.get("types")
    general = resource_type.get("resourceTypeGeneral") if isinstance(resource_type, dict) else None
    kind_by_type: dict[str, ResourceKind] = {
        "Dataset": "dataset",
        "Collection": "dataset",
        "Project": "document",
        "Service": "service",
        "Text": "document",
    }
    if general not in kind_by_type:
        raise MetadataImportInvalid("DataCite resourceTypeGeneral is unsupported")
    known_attributes = {
        "doi",
        "titles",
        "descriptions",
        "language",
        "subjects",
        "rightsList",
        "publisher",
        "publicationYear",
        "creators",
        "contributors",
        "types",
        "version",
        "geoLocations",
        "dates",
        "relatedIdentifiers",
        "alternateIdentifiers",
        "formats",
        "sizes",
        "fundingReferences",
        "schemaVersion",
    }
    extensions = {
        "datacite": {
            key: attributes[key]
            for key in (
                "doi",
                "creators",
                "contributors",
                "publisher",
                "publicationYear",
                "relatedIdentifiers",
                "alternateIdentifiers",
                "formats",
                "sizes",
                "fundingReferences",
            )
            if key in attributes
        }
    }
    catalog_contacts, catalog_contact_unmapped = _datacite_catalog_contacts(
        creators, attributes.get("contributors"), attributes.get("publisher")
    )
    catalog_funding, catalog_funding_unmapped = _datacite_catalog_funding(
        attributes.get("fundingReferences")
    )
    if catalog_contacts or catalog_funding:
        catalog_extension: dict[str, Any] = {
            "schemaVersion": "1.1.0" if catalog_funding else "1.0.0"
        }
        if catalog_contacts:
            catalog_extension["contacts"] = catalog_contacts
        if catalog_funding:
            catalog_extension["funding"] = catalog_funding
        extensions["opengeo"] = catalog_extension
    mapped = [
        "data.type=dois->source_format",
        "data.attributes.doi->source_identifier",
        "data.attributes.types.resourceTypeGeneral->kind",
        "data.attributes.titles->title/translations",
        "data.attributes.language->language",
        "data.attributes.subjects->keywords",
        "data.attributes.publisher->attribution/metadata_extensions",
        "data.attributes.creators/contributors->metadata_extensions",
    ]
    if catalog_contacts:
        mapped.append(
            "data.attributes.creators/contributors/publisher->metadata_extensions.opengeo.contacts"
        )
    if catalog_funding:
        mapped.append("data.attributes.fundingReferences->metadata_extensions.opengeo.funding")
    for source, target in (
        ("descriptions", "abstract/translations"),
        ("rightsList", "license"),
        ("geoLocations", "spatial_extent"),
        ("dates", "temporal_extent"),
    ):
        if source in attributes:
            mapped.append(f"data.attributes.{source}->{target}")
    unmapped = [
        *(f"data.{key}" for key in sorted(set(data) - {"id", "type", "attributes"})),
        *(f"data.attributes.{key}" for key in sorted(set(attributes) - known_attributes)),
        *unmapped_descriptions,
        *multilingual_unmapped,
        *catalog_contact_unmapped,
        *catalog_funding_unmapped,
    ]
    defaulted = [] if attributes.get("language") or title_values[0][1] else ["language=en"]
    report = _report("datacite_4_7", mapped, defaulted, sorted(unmapped), [])
    return _plan(
        source_format="datacite_4_7",
        source_version=DATACITE_VERSION,
        namespace=namespace,
        identifier=identifier,
        checksum=checksum,
        document=document,
        report=report,
        kind=kind_by_type[cast(str, general)],
        slug=slug,
        visibility=visibility,
        title=title,
        abstract=abstract,
        language=language,
        license_value=license_value,
        attribution=publisher,
        keywords=keywords,
        translations=translations,
        spatial_extent=spatial_extent,
        temporal_start=temporal_start,
        temporal_end=temporal_end,
        managed_profile_id=managed_profile_id,
        managed_profile_version=managed_profile_version,
        metadata_profile=metadata_profile,
        extensions=extensions,
    )


def _geodcat_plan(
    namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: dict[str, Any],
    checksum: str,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
) -> MetadataResourceImportPlan:
    profile_fields = {
        key: document[key]
        for key in (
            "dct:conformsTo",
            "dcat:theme",
            "geodcatap:resourceType",
            "geodcatap:topicCategory",
            "geodcatap:referenceSystem",
            "dcat:spatialResolutionInMeters",
        )
        if key in document
    }
    return _dcat_plan(
        namespace,
        slug,
        visibility,
        document,
        checksum,
        managed_profile_id,
        managed_profile_version,
        metadata_profile,
        extensions={"geodcat_ap": profile_fields} if profile_fields else {},
        source_format="geodcat_ap_3_1",
        source_version=GEODCAT_AP_VERSION,
        known_extensions=set(profile_fields),
    )


def _iso_plan(
    namespace: str,
    slug: str,
    visibility: ResourceVisibility,
    document: str,
    checksum: str,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
) -> MetadataResourceImportPlan:
    root = _parse_safe_iso_xml(document)
    identifier_scope = _first_scope(root, "metadataIdentifier")
    identifier = _bounded_string(
        _first_text(identifier_scope, "CharacterString", "code"),
        1,
        500,
        "ISO metadata identifier",
    )
    identification = _first_scope(root, "identificationInfo")
    title_scope = _first_scope(identification, "title")
    abstract_scope = _first_scope(identification, "abstract")
    title = _bounded_string(
        _first_text(title_scope, "CharacterString"), 1, 300, "ISO resource title"
    )
    abstract = _optional_string(
        _first_text(abstract_scope, "CharacterString"), 8_000, "ISO abstract"
    )
    language_code = _first_element(root, "LanguageCode")
    language_value = (
        language_code.attrib.get("codeListValue") or language_code.text
        if language_code is not None
        else None
    )
    language = _language(language_value or "en").lower()
    keywords = tuple(
        _bounded_string(value, 1, 100, "ISO keyword")
        for value in _texts_in_scopes(identification, "keyword", "CharacterString")[:64]
    )
    if len({value.casefold() for value in keywords}) != len(keywords):
        raise MetadataImportInvalid("ISO keywords must be unique")
    license_scope = _first_scope(identification, "useLimitation")
    license_value = _optional_string(
        _first_text(license_scope, "CharacterString"), 1_000, "ISO use limitation"
    )
    attribution_scope = _first_scope(identification, "credit")
    attribution = _optional_string(
        _first_text(attribution_scope, "CharacterString"), 2_000, "ISO credit"
    )
    spatial_extent = _iso_spatial(identification)
    temporal_start, temporal_end = _iso_temporal(identification)
    catalog_extension, catalog_mapped, catalog_unmapped = _iso_catalog_extension(root)
    root_names = {_local_name(element.tag) for element in root.iter()}
    mapped = [
        "mdb:metadataIdentifier->source_identifier",
        "mdb:identificationInfo.citation.title->title",
        "mdb:defaultLocale.LanguageCode->language",
    ]
    mapped.extend(catalog_mapped)
    for source, target, condition in (
        ("mri:abstract", "abstract", abstract is not None),
        ("mri:descriptiveKeywords", "keywords", bool(keywords)),
        ("mri:resourceConstraints.useLimitation", "license", license_value is not None),
        ("mri:credit", "attribution", attribution is not None),
        ("gex:EX_GeographicBoundingBox", "spatial_extent", spatial_extent is not None),
        (
            "gml:TimePeriod",
            "temporal_extent",
            temporal_start is not None or temporal_end is not None,
        ),
    ):
        if condition:
            mapped.append(f"{source}->{target}")
    mapped_root_sections = {
        source
        for source, target in (
            ("contact", "contacts"),
            ("referenceSystemInfo", "referenceSystems"),
            ("distributionInfo", "distributions"),
            ("dataQualityInfo", "quality"),
            ("resourceLineage", "lineage"),
            ("acquisitionInformation", "acquisition"),
        )
        if catalog_extension and catalog_extension.get(target)
    }
    explicitly_unmapped: list[str] = [
        name
        for name in (
            "contact",
            "referenceSystemInfo",
            "distributionInfo",
            "dataQualityInfo",
            "resourceLineage",
            "acquisitionInformation",
            "LocalisedCharacterString",
        )
        if name in root_names and name not in mapped_root_sections
    ]
    explicitly_unmapped.extend(catalog_unmapped)
    report = _report(
        "iso_19115_3",
        mapped,
        ["language=en"] if language_value is None else [],
        explicitly_unmapped,
        [],
        raw_source=True,
    )
    extensions = {"iso_19115_3": {"metadataIdentifier": identifier}}
    if catalog_extension:
        extensions["opengeo"] = catalog_extension
    return _plan(
        source_format="iso_19115_3",
        source_version=ISO_19115_3_VERSION,
        namespace=namespace,
        identifier=identifier,
        checksum=checksum,
        document=document,
        report=report,
        kind="service" if "SV_ServiceIdentification" in root_names else "dataset",
        slug=slug,
        visibility=visibility,
        title=title,
        abstract=abstract,
        language=language,
        license_value=license_value,
        attribution=attribution,
        keywords=keywords,
        translations={},
        spatial_extent=spatial_extent,
        temporal_start=temporal_start,
        temporal_end=temporal_end,
        managed_profile_id=managed_profile_id,
        managed_profile_version=managed_profile_version,
        metadata_profile=metadata_profile,
        extensions=extensions,
    )


def _plan(
    *,
    source_format: MetadataSourceFormat,
    source_version: str,
    namespace: str,
    identifier: str,
    checksum: str,
    document: MetadataSourceValue,
    report: dict[str, Any],
    kind: ResourceKind,
    slug: str,
    visibility: ResourceVisibility,
    title: str,
    abstract: str | None,
    language: str,
    license_value: str | None,
    attribution: str | None,
    keywords: tuple[str, ...],
    translations: dict[str, dict[str, Any]],
    spatial_extent: tuple[float, float, float, float] | None,
    temporal_start: datetime | None,
    temporal_end: datetime | None,
    managed_profile_id: UUID | None,
    managed_profile_version: int | None,
    metadata_profile: str,
    extensions: dict[str, Any] | None = None,
) -> MetadataResourceImportPlan:
    metadata_extensions = extensions or {}
    try:
        metadata_extensions = validate_catalog_extensions(metadata_extensions)
    except CatalogMetadataInvalid as error:
        raise MetadataImportInvalid(str(error)) from error
    if len(canonical_json_bytes(metadata_extensions)) > 8_192:
        raise MetadataImportInvalid("mapped metadata extensions exceed 8192 canonical bytes")
    provenance = {
        "sourceFormat": source_format,
        "sourceVersion": source_version,
        "sourceNamespace": namespace,
        "sourceIdentifier": identifier,
        "sourceSha256": checksum,
        "checksumBasis": "raw_utf8" if isinstance(document, str) else "canonical_json",
    }
    return MetadataResourceImportPlan(
        source_format=source_format,
        source_version=source_version,
        source_namespace=namespace,
        source_identifier=identifier,
        source_sha256=checksum,
        source_document=document,
        conversion_report=report,
        draft=ResourceDraft(
            kind=kind,
            slug=slug,
            dataset_id=None,
            map_id=None,
            visibility=visibility,
            state="review",
            metadata=ResourceMetadata(
                title=title,
                abstract=abstract,
                language=language,
                license=license_value,
                attribution=attribution,
                keywords=keywords,
                spatial_extent=spatial_extent,
                temporal_start=temporal_start,
                temporal_end=temporal_end,
                profile=metadata_profile,
                extensions=metadata_extensions,
                translations=translations,
                managed_profile_id=managed_profile_id,
                managed_profile_version=managed_profile_version,
            ),
            content={"blocks": []},
            provenance=provenance,
        ),
    )


def _report(
    source_format: MetadataSourceFormat,
    mapped: list[str],
    defaulted: list[str],
    unmapped: list[str],
    derived: list[str],
    *,
    raw_source: bool = False,
) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0.0",
        "sourceFormat": source_format,
        "status": "mapped_with_explicit_losses" if unmapped or defaulted or derived else "mapped",
        "mapped": mapped,
        "defaulted": defaulted,
        "derived": derived,
        "unmapped": unmapped,
        "preservedSource": {
            "status": "exact_utf8_preserved" if raw_source else "canonical_json_preserved",
            "checksumBasis": "raw_utf8" if raw_source else "canonical_json",
            "syntacticIdentity": raw_source,
        },
    }


def _has_dcat_context(value: Any) -> bool:
    values = value if isinstance(value, list) else [value]
    dcat = False
    dct = False
    for item in values:
        if isinstance(item, str) and item in _DCAT_CONTEXTS:
            dcat = dct = True
        elif isinstance(item, dict):
            dcat = dcat or item.get("dcat") == "http://www.w3.org/ns/dcat#"
            dct = dct or item.get("dct") == "http://purl.org/dc/terms/"
    return dcat and dct


def _has_geodcat_context(value: Any) -> bool:
    values = value if isinstance(value, list) else [value]
    return any(
        isinstance(item, dict)
        and (
            item.get("geodcatap") == _GEODCAT_NAMESPACE or item.get("@vocab") == _GEODCAT_NAMESPACE
        )
        for item in values
    )


def _has_schema_org_context(value: Any) -> bool:
    values = value if isinstance(value, list) else [value]
    for item in values:
        if isinstance(item, str) and item in _SCHEMA_ORG_CONTEXTS:
            return True
        if isinstance(item, dict) and item.get("@vocab") in _SCHEMA_ORG_CONTEXTS:
            return True
    return False


def _jsonld_localized_values(
    value: Any, maximum: int, label: str, *, optional: bool = False
) -> list[tuple[str, str | None]]:
    return _dcat_localized_values(value, maximum, label, optional=optional)


def _source_primary_language(declared: Any, title_values: list[tuple[str, str | None]]) -> str:
    if declared is not None:
        if isinstance(declared, list):
            if not declared:
                raise MetadataImportInvalid("metadata language list must not be empty")
            declared = declared[0]
        return _language(declared).lower()
    tagged = next((language for _, language in title_values if language is not None), None)
    return tagged.lower() if tagged is not None else "en"


def _localized_metadata(
    title_values: list[tuple[str, str | None]],
    description_values: list[tuple[str, str | None]],
    attribution_values: list[tuple[str, str | None]],
    keyword_values: list[tuple[str, str | None]],
    language: str,
) -> tuple[str, str | None, dict[str, dict[str, Any]], list[str]]:
    primary_titles = [value for value, item_language in title_values if item_language == language]
    untagged_titles = [value for value, item_language in title_values if item_language is None]
    title = (primary_titles or untagged_titles or [title_values[0][0]])[0]
    translations: dict[str, dict[str, Any]] = {
        item_language.lower(): {"title": value}
        for value, item_language in title_values
        if item_language is not None and item_language.lower() != language
    }
    unmapped: list[str] = []
    for label, target, values in (
        ("description", "abstract", description_values),
        ("attribution", "attribution", attribution_values),
    ):
        for value, item_language in values:
            if item_language is None or item_language == language:
                continue
            translation = translations.get(item_language)
            if translation is None:
                unmapped.append(f"{label}[{item_language}]")
            else:
                translation[target] = value
    for value, item_language in keyword_values:
        if item_language is None or item_language == language:
            continue
        translation = translations.get(item_language)
        if translation is None:
            unmapped.append(f"keywords[{item_language}]")
        else:
            translation.setdefault("keywords", []).append(value)
    abstract = _primary_localized_value(description_values, language)
    return title, abstract, translations, unmapped


def _unique_localized_languages(values: list[tuple[str, str | None]], label: str) -> None:
    languages = [language for _, language in values]
    if len(languages) != len(set(languages)):
        raise MetadataImportInvalid(f"{label} languages must be unique")


def _schema_identifier(value: Any) -> str:
    if isinstance(value, dict):
        if value.get("@type") not in {None, "PropertyValue"}:
            raise MetadataImportInvalid("schema.org identifier type is unsupported")
        value = value.get("value", value.get("propertyID"))
    return _bounded_string(value, 1, 500, "schema.org identifier")


def _schema_scalar(value: Any, maximum: int, label: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = value.get("@id", value.get("url", value.get("name")))
    return _bounded_string(value, 1, maximum, label)


def _schema_agent_name(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("name")
    return _optional_string(value, 2_000, label)


def _dcat_catalog_extension(
    document: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str], list[str], list[str]]:
    contacts: list[dict[str, str]] = []
    for field, role in (
        ("dcat:contactPoint", "pointOfContact"),
        ("dct:creator", "creator"),
        ("dct:publisher", "publisher"),
    ):
        for value in _metadata_items(document.get(field)):
            contact = _catalog_contact(value, role, f"DCAT {field}")
            if contact is not None and contact not in contacts:
                contacts.append(contact)

    distributions: list[dict[str, Any]] = []
    for index, value in enumerate(_metadata_items(document.get("dcat:distribution"))):
        if not isinstance(value, dict):
            raise MetadataImportInvalid("DCAT distributions must be objects")
        distribution: dict[str, Any] = {}
        for source, target, maximum in (
            ("dct:identifier", "identifier", 1_000),
            ("dct:title", "title", 1_000),
            ("dcat:accessURL", "accessUrl", 2_048),
            ("dcat:downloadURL", "downloadUrl", 2_048),
            ("dcat:mediaType", "mediaType", 1_000),
            ("dct:format", "format", 1_000),
            ("dct:license", "license", 1_000),
        ):
            raw = (
                _metadata_scalar(value.get(source))
                if source in {"dcat:accessURL", "dcat:downloadURL"}
                else _metadata_label(value.get(source))
            )
            if raw is not None:
                distribution[target] = _bounded_string(
                    raw, 1, maximum, f"DCAT distribution {index} {source}"
                )
        byte_size = value.get("dcat:byteSize")
        if isinstance(byte_size, dict):
            byte_size = byte_size.get("@value")
        if byte_size is not None:
            if isinstance(byte_size, str) and byte_size.isdigit():
                byte_size = int(byte_size)
            distribution["byteSize"] = byte_size
        checksum = value.get("spdx:checksum")
        if isinstance(checksum, dict):
            checksum = _metadata_scalar(checksum.get("spdx:checksumValue"))
        if checksum is not None:
            distribution["checksumSha256"] = checksum
        if "accessUrl" not in distribution and "downloadUrl" not in distribution:
            raise MetadataImportInvalid(
                f"DCAT distribution {index} requires dcat:accessURL or dcat:downloadURL"
            )
        distributions.append(distribution)

    reference_systems: list[dict[str, str]] = []
    for value in _metadata_items(document.get("geodcatap:referenceSystem")):
        uri = _metadata_scalar(value)
        if uri is None:
            continue
        label = None
        if isinstance(value, dict):
            label = _metadata_scalar(value.get("skos:prefLabel"))
        reference = {
            "identifier": _bounded_string(
                label or uri.rstrip("/").rsplit("/", 1)[-1],
                1,
                300,
                "GeoDCAT-AP reference system identifier",
            ),
            "uri": _bounded_string(uri, 1, 2_048, "GeoDCAT-AP reference system URI"),
        }
        if reference not in reference_systems:
            reference_systems.append(reference)

    lineage: dict[str, Any] | None = None
    provenance = _metadata_label(document.get("dct:provenance"))
    sources = [
        _bounded_string(value, 1, 2_048, "DCAT prov:wasDerivedFrom")
        for item in _metadata_items(document.get("prov:wasDerivedFrom"))
        if (value := _metadata_scalar(item)) is not None
    ]
    lineage_derived: list[str] = []
    if provenance is not None or sources:
        lineage = {
            "statement": _bounded_string(
                provenance or "Source relationships supplied by prov:wasDerivedFrom.",
                1,
                4_000,
                "DCAT provenance",
            )
        }
        if sources:
            lineage["sources"] = sources
        if provenance is None:
            lineage_derived.append("opengeo.lineage.statement from prov:wasDerivedFrom")

    quality: list[dict[str, Any]] = []
    for index, value in enumerate(_metadata_items(document.get("dqv:hasQualityMeasurement"))):
        if not isinstance(value, dict):
            raise MetadataImportInvalid("DCAT quality measurements must be objects")
        measure = _metadata_label(value.get("dqv:isMeasurementOf"))
        result = value.get("dqv:value")
        if isinstance(result, dict):
            result = result.get("@value")
        if measure is None or not isinstance(result, str | int | float | bool):
            raise MetadataImportInvalid(
                f"DCAT quality measurement {index} requires a measure and scalar value"
            )
        record: dict[str, Any] = {
            "measure": _bounded_string(measure, 1, 300, "DCAT quality measure"),
            "result": result,
        }
        unit = _metadata_label(value.get("sdmx-attribute:unitMeasure"))
        if unit is not None:
            record["unit"] = _bounded_string(unit, 1, 1_000, "DCAT quality unit")
        description = _metadata_label(value.get("dct:description"))
        if description is not None:
            record["description"] = _bounded_string(
                description, 1, 1_000, "DCAT quality description"
            )
        quality.append(record)

    catalog: dict[str, Any] = {"schemaVersion": "1.0.0"}
    mapped: list[str] = []
    unmapped: list[str] = []
    for value, name, source in (
        (contacts, "contacts", "dcat:contactPoint/dct:creator/dct:publisher"),
        (distributions, "distributions", "dcat:distribution"),
        (reference_systems, "referenceSystems", "geodcatap:referenceSystem"),
        (lineage, "lineage", "dct:provenance/prov:wasDerivedFrom"),
        (quality, "quality", "dqv:hasQualityMeasurement"),
    ):
        if value:
            catalog[name] = value
            mapped.append(f"{source}->metadata_extensions.opengeo.{name}")
    for source, target in (
        ("dct:accrualPeriodicity", "updateFrequency"),
        ("dct:accessRights", "sensitivity"),
    ):
        raw = _metadata_label(document.get(source))
        if raw is not None:
            normalized = _bounded_string(raw, 1, 300, f"DCAT {source}")
            if target == "sensitivity" and normalized not in {
                "public",
                "internal",
                "confidential",
                "restricted",
            }:
                unmapped.append(source)
                continue
            catalog[target] = normalized
            mapped.append(f"{source}->metadata_extensions.opengeo.{target}")
    return (catalog if len(catalog) > 1 else None), mapped, lineage_derived, unmapped


def _schema_catalog_extension(
    document: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str], list[str], list[str]]:
    contacts: list[dict[str, str]] = []
    for field, role in (("creator", "creator"), ("publisher", "publisher")):
        for value in _metadata_items(document.get(field)):
            contact = _catalog_contact(value, role, f"schema.org {field}")
            if contact is not None and contact not in contacts:
                contacts.append(contact)
    distributions: list[dict[str, Any]] = []
    for index, value in enumerate(_metadata_items(document.get("distribution"))):
        if not isinstance(value, dict):
            raise MetadataImportInvalid("schema.org distributions must be objects")
        distribution: dict[str, Any] = {}
        for source, target, maximum in (
            ("identifier", "identifier", 1_000),
            ("name", "title", 1_000),
            ("url", "accessUrl", 2_048),
            ("contentUrl", "downloadUrl", 2_048),
            ("encodingFormat", "mediaType", 1_000),
            ("contentSize", "format", 1_000),
        ):
            raw = _metadata_scalar(value.get(source))
            if raw is not None:
                distribution[target] = _bounded_string(
                    raw, 1, maximum, f"schema.org distribution {index} {source}"
                )
        if "accessUrl" not in distribution and "downloadUrl" not in distribution:
            raise MetadataImportInvalid(
                f"schema.org distribution {index} requires url or contentUrl"
            )
        distributions.append(distribution)
    lineage: dict[str, Any] | None = None
    sources = [
        _bounded_string(value, 1, 2_048, "schema.org isBasedOn")
        for item in _metadata_items(document.get("isBasedOn"))
        if (value := _metadata_scalar(item)) is not None
    ]
    derived: list[str] = []
    if sources:
        lineage = {
            "statement": "Source relationships supplied by schema.org isBasedOn.",
            "sources": sources,
        }
        derived.append("opengeo.lineage.statement from schema.org isBasedOn")
    catalog: dict[str, Any] = {"schemaVersion": "1.0.0"}
    mapped: list[str] = []
    for value, name, source in (
        (contacts, "contacts", "creator/publisher"),
        (distributions, "distributions", "distribution"),
        (lineage, "lineage", "isBasedOn"),
    ):
        if value:
            catalog[name] = value
            mapped.append(f"{source}->metadata_extensions.opengeo.{name}")
    return (catalog if len(catalog) > 1 else None), mapped, derived, []


def _catalog_contact(value: Any, role: str, label: str) -> dict[str, str] | None:
    if isinstance(value, str):
        return {"name": _bounded_string(value, 1, 300, label), "role": role}
    if not isinstance(value, dict):
        if value is None:
            return None
        raise MetadataImportInvalid(f"{label} must be a string or object")
    contact: dict[str, str] = {"role": role}
    for names, target in (
        (("name", "schema:name", "foaf:name", "vcard:fn", "rdfs:label"), "name"),
        (("organization", "vcard:organization-name"), "organization"),
        (("email", "schema:email", "vcard:hasEmail"), "email"),
        (("identifier", "@id"), "identifier"),
    ):
        raw = next((_metadata_scalar(value.get(name)) for name in names if name in value), None)
        if raw is None:
            continue
        if target == "email" and raw.startswith("mailto:"):
            raw = raw[7:]
        contact[target] = _bounded_string(raw, 1, 300, f"{label} {target}")
    if "name" not in contact and "organization" not in contact:
        identifier = contact.get("identifier")
        if identifier is None:
            return None
        contact["name"] = identifier
    return contact


def _metadata_items(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _metadata_scalar(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = value.get("@value", value.get("@id", value.get("name")))
    if isinstance(value, str):
        return value
    return None


def _metadata_label(value: Any) -> str | None:
    if isinstance(value, dict):
        for field in ("rdfs:label", "skos:prefLabel", "foaf:name", "vcard:fn", "name"):
            if field in value and (label := _metadata_scalar(value[field])) is not None:
                return label
    return _metadata_scalar(value)


def _schema_spatial(value: Any) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise MetadataImportInvalid("schema.org spatialCoverage must be a Place")
    geo = value.get("geo")
    if not isinstance(geo, dict) or geo.get("@type") != "GeoShape":
        raise MetadataImportInvalid("schema.org spatialCoverage must contain a GeoShape")
    box = geo.get("box")
    if not isinstance(box, str):
        raise MetadataImportInvalid("schema.org GeoShape box must be a string")
    try:
        values = [float(item) for item in box.split()]
    except ValueError as error:
        raise MetadataImportInvalid("schema.org GeoShape box coordinates are invalid") from error
    if len(values) != 4:
        raise MetadataImportInvalid("schema.org GeoShape box must contain four coordinates")
    min_y, min_x, max_y, max_x = values
    return _bbox((min_x, min_y, max_x, max_y), "schema.org spatialCoverage")


def _schema_temporal(value: Any) -> tuple[datetime | None, datetime | None]:
    if value is None:
        return None, None
    interval = _bounded_string(value, 1, 201, "schema.org temporalCoverage")
    if "/" not in interval:
        instant = _optional_datetime(interval, "schema.org temporalCoverage")
        return instant, instant
    start_value, end_value = interval.split("/", 1)
    start = (
        None
        if start_value in {"", ".."}
        else _optional_datetime(start_value, "schema.org temporal start")
    )
    end = (
        None
        if end_value in {"", ".."}
        else _optional_datetime(end_value, "schema.org temporal end")
    )
    _temporal_order(start, end)
    return start, end


def _datacite_publisher(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        value = value.get("name") or value.get("publisher")
    return _bounded_string(value, 1, 2_000, "DataCite publisher")


def _datacite_catalog_contacts(
    creators: list[Any], contributors_value: Any, publisher_value: Any
) -> tuple[list[dict[str, str]], list[str]]:
    contacts: list[dict[str, str]] = []
    unmapped: list[str] = []

    def append_contact(value: Any, role: str, path: str) -> None:
        if not isinstance(value, dict):
            unmapped.append(path)
            return
        raw_name = value.get("name") or value.get("creatorName") or value.get("contributorName")
        if not isinstance(raw_name, str) or not 1 <= len(raw_name.strip()) <= 300:
            unmapped.append(path)
            return
        contact: dict[str, str] = {"role": role}
        target = "organization" if value.get("nameType") == "Organizational" else "name"
        contact[target] = raw_name.strip()
        identifiers = value.get("nameIdentifiers", [])
        if isinstance(identifiers, list) and identifiers:
            identifier = identifiers[0]
            raw_identifier = (
                identifier.get("nameIdentifier") if isinstance(identifier, dict) else None
            )
            if isinstance(raw_identifier, str) and 1 <= len(raw_identifier.strip()) <= 300:
                contact["identifier"] = raw_identifier.strip()
        if len(contacts) < 32:
            contacts.append(contact)
        else:
            unmapped.append(path)

    for index, creator in enumerate(creators):
        append_contact(creator, "creator", f"data.attributes.creators[{index}]")
    contributors = contributors_value if isinstance(contributors_value, list) else []
    for index, contributor in enumerate(contributors):
        role = (
            str(contributor.get("contributorType"))
            if isinstance(contributor, dict) and contributor.get("contributorType")
            else "contributor"
        )
        append_contact(contributor, role, f"data.attributes.contributors[{index}]")
    publisher_name = (
        publisher_value.get("name") if isinstance(publisher_value, dict) else publisher_value
    )
    if isinstance(publisher_name, str) and 1 <= len(publisher_name.strip()) <= 300:
        if len(contacts) < 32:
            contacts.append({"organization": publisher_name.strip(), "role": "publisher"})
        else:
            unmapped.append("data.attributes.publisher[opengeo.contacts]")
    return contacts, unmapped


def _datacite_catalog_funding(value: Any) -> tuple[list[dict[str, str]], list[str]]:
    if value is None:
        return [], []
    if not isinstance(value, list) or len(value) > 100:
        raise MetadataImportInvalid("DataCite fundingReferences must contain at most 100 values")
    allowed = {
        "funderName",
        "funderIdentifier",
        "funderIdentifierType",
        "schemeUri",
        "awardNumber",
        "awardUri",
        "awardTitle",
    }
    funding: list[dict[str, str]] = []
    unmapped: list[str] = []
    for index, item in enumerate(value):
        path = f"data.attributes.fundingReferences[{index}]"
        if not isinstance(item, dict):
            raise MetadataImportInvalid("DataCite fundingReferences must be objects")
        if index >= 32:
            unmapped.append(path)
            continue
        unknown = sorted(set(item) - allowed)
        unmapped.extend(f"{path}.{field}" for field in unknown)
        record: dict[str, str] = {
            "funderName": _bounded_string(
                item.get("funderName"), 1, 300, f"DataCite funding reference {index} name"
            )
        }
        for field, maximum in (
            ("funderIdentifier", 2_048),
            ("funderIdentifierType", 100),
            ("schemeUri", 2_048),
            ("awardNumber", 300),
            ("awardUri", 2_048),
            ("awardTitle", 1_000),
        ):
            if field in item:
                record[field] = _bounded_string(
                    item[field], 1, maximum, f"DataCite funding reference {index} {field}"
                )
        funding.append(record)
    return funding, unmapped


def _datacite_spatial(value: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(value, list) or len(value) > 100:
        raise MetadataImportInvalid("DataCite geoLocations must contain at most 100 values")
    boxes: list[tuple[float, float, float, float]] = []
    for item in value:
        if not isinstance(item, dict):
            raise MetadataImportInvalid("DataCite geoLocations must be objects")
        box = item.get("geoLocationBox")
        if box is None:
            continue
        if not isinstance(box, dict):
            raise MetadataImportInvalid("DataCite geoLocationBox must be an object")
        boxes.append(
            _bbox(
                (
                    box.get("westBoundLongitude"),
                    box.get("southBoundLatitude"),
                    box.get("eastBoundLongitude"),
                    box.get("northBoundLatitude"),
                ),
                "DataCite geoLocationBox",
            )
        )
    if not boxes:
        return None
    return (
        min(item[0] for item in boxes),
        min(item[1] for item in boxes),
        max(item[2] for item in boxes),
        max(item[3] for item in boxes),
    )


def _datacite_temporal(value: Any) -> tuple[datetime | None, datetime | None]:
    if not isinstance(value, list) or len(value) > 100:
        raise MetadataImportInvalid("DataCite dates must contain at most 100 values")
    for item in value:
        if not isinstance(item, dict):
            raise MetadataImportInvalid("DataCite dates must be objects")
        if item.get("dateType") == "Coverage":
            return _schema_temporal(item.get("date"))
    return None, None


def _iso_catalog_extension(
    root: ET.Element,
) -> tuple[dict[str, Any] | None, list[str], list[str]]:
    contacts: list[dict[str, str]] = []
    for index, contact_scope in enumerate(_direct_children(root, "contact")):
        responsibility = _first_scope(contact_scope, "CI_Responsibility")
        if responsibility is None:
            continue
        role_element = _first_element(responsibility, "CI_RoleCode")
        role = (
            role_element.attrib.get("codeListValue") or role_element.text
            if role_element is not None
            else None
        )
        organisation = _first_element(responsibility, "CI_Organisation")
        individual = _first_element(responsibility, "CI_Individual")
        party = organisation if organisation is not None else individual
        if party is None:
            continue
        name_scope = next(
            (child for child in party if _local_name(child.tag) == "name"),
            None,
        )
        name = _first_text(name_scope, "CharacterString")
        if name is None:
            continue
        contact: dict[str, str] = {
            "organization" if organisation is not None else "name": _bounded_string(
                name, 1, 300, f"ISO contact {index} name"
            )
        }
        if role:
            contact["role"] = _bounded_string(role, 1, 300, f"ISO contact {index} role")
        email_scope = _first_scope(party, "electronicMailAddress")
        email = _first_text(email_scope, "CharacterString")
        if email:
            contact["email"] = _bounded_string(email, 1, 300, f"ISO contact {index} email")
        identifier_scope = _first_scope(party, "partyIdentifier")
        party_identifier = _first_text(identifier_scope, "CharacterString", "code")
        if party_identifier:
            contact["identifier"] = _bounded_string(
                party_identifier, 1, 300, f"ISO contact {index} identifier"
            )
        contacts.append(contact)

    reference_systems: list[dict[str, str]] = []
    for index, reference_scope in enumerate(_direct_children(root, "referenceSystemInfo")):
        identifier_scope = _first_scope(reference_scope, "referenceSystemIdentifier")
        code_scope = _first_scope(identifier_scope, "code")
        code = _first_text(code_scope, "CharacterString")
        if code is None:
            continue
        reference: dict[str, str] = {
            "identifier": _bounded_string(code, 1, 300, f"ISO reference system {index}")
        }
        code_space_scope = _first_scope(identifier_scope, "codeSpace")
        code_space = _first_text(code_space_scope, "CharacterString")
        if code_space and (
            code_space.startswith("https://")
            or code_space.startswith("http://")
            or code_space.startswith("urn:")
        ):
            reference["uri"] = _bounded_string(
                code_space, 1, 2_048, f"ISO reference system {index} code space"
            )
        reference_systems.append(reference)

    distributions: list[dict[str, Any]] = []
    distribution_unmapped = False
    for distribution_scope in _direct_children(root, "distributionInfo"):
        online_resources = [
            element
            for element in distribution_scope.iter()
            if _local_name(element.tag) == "CI_OnlineResource"
        ]
        if not online_resources:
            distribution_unmapped = True
            continue
        for index, online in enumerate(online_resources):
            linkage_scope = _first_scope(online, "linkage")
            linkage = _first_text(linkage_scope, "CharacterString")
            if linkage is None or not linkage.startswith("https://"):
                distribution_unmapped = True
                continue
            function_element = _first_element(online, "CI_OnLineFunctionCode")
            function = (
                function_element.attrib.get("codeListValue") or function_element.text
                if function_element is not None
                else None
            )
            target = "downloadUrl" if function == "download" else "accessUrl"
            distribution: dict[str, Any] = {
                target: _bounded_string(linkage, 1, 2_048, f"ISO distribution {index} URL")
            }
            title_scope = _first_scope(online, "name")
            title = _first_text(title_scope, "CharacterString")
            if title:
                distribution["title"] = _bounded_string(
                    title, 1, 1_000, f"ISO distribution {index} name"
                )
            protocol_scope = _first_scope(online, "protocol")
            protocol = _first_text(protocol_scope, "CharacterString")
            if protocol:
                distribution["format"] = _bounded_string(
                    protocol, 1, 1_000, f"ISO distribution {index} protocol"
                )
            distributions.append(distribution)

    quality: list[dict[str, Any]] = []
    for index, quality_scope in enumerate(_direct_children(root, "dataQualityInfo")):
        for report in (
            element for element in quality_scope.iter() if _local_name(element.tag) == "report"
        ):
            quality_element = next(iter(report), None)
            if quality_element is None:
                continue
            measure_scope = _first_scope(quality_element, "measure")
            measure = _first_text(_first_scope(measure_scope, "nameOfMeasure"), "CharacterString")
            if measure is None:
                continue
            quantitative = _first_element(quality_element, "DQ_QuantitativeResult")
            descriptive = _first_element(quality_element, "DQ_DescriptiveResult")
            if quantitative is not None:
                raw_result = _first_text(quantitative, "Record")
                result = _iso_quality_scalar(raw_result)
            elif descriptive is not None:
                result = _first_text(descriptive, "statement", "CharacterString")
            else:
                result = None
            if result is None:
                continue
            record: dict[str, Any] = {
                "measure": _bounded_string(
                    measure, 1, 300, f"ISO quality measurement {index} name"
                ),
                "result": result,
            }
            description = _first_text(
                _first_scope(measure_scope, "measureDescription"), "CharacterString"
            )
            if description:
                record["description"] = _bounded_string(
                    description,
                    1,
                    1_000,
                    f"ISO quality measurement {index} description",
                )
            quality.append(record)

    lineage: dict[str, Any] | None = None
    lineage_scopes = _direct_children(root, "resourceLineage")
    if lineage_scopes:
        statement_scope = _first_scope(lineage_scopes[0], "statement")
        statement = _first_text(statement_scope, "CharacterString")
        if statement:
            lineage = {"statement": _bounded_string(statement, 1, 4_000, "ISO lineage statement")}
            sources = [
                _bounded_string(value, 1, 2_048, "ISO lineage source")
                for source in lineage_scopes[0].iter()
                if _local_name(source.tag) == "LI_Source"
                and (value := _first_text(_first_scope(source, "description"), "CharacterString"))
            ]
            if sources:
                lineage["sources"] = sources

    acquisition: dict[str, Any] | None = None
    acquisition_unmapped: list[str] = []
    acquisition_scopes = _direct_children(root, "acquisitionInformation")
    instruments: list[dict[str, str]] = []
    operations: list[dict[str, str]] = []
    platforms: list[dict[str, Any]] = []
    plans: list[dict[str, Any]] = []
    objectives: list[dict[str, Any]] = []
    requirements: list[dict[str, Any]] = []
    platform_passes: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    instrument_xml_ids: dict[str, str] = {}
    operation_xml_ids: dict[str, str] = {}
    requirement_xml_ids: dict[str, str] = {}
    objective_xml_ids: dict[str, str] = {}
    platform_pass_xml_ids: dict[str, str] = {}
    event_xml_ids: dict[str, str] = {}

    def acquisition_instrument(element: ET.Element, path: str) -> dict[str, str] | None:
        acquisition_unmapped.extend(
            f"{path}.{name}"
            for name in sorted(
                {
                    _local_name(child.tag)
                    for child in element
                    if _local_name(child.tag) not in {"identifier", "type", "description"}
                }
            )
        )
        identifier = _first_text(_direct_child(element, "identifier"), "CharacterString", "code")
        instrument_type = _first_text(_direct_child(element, "type"), "CharacterString")
        if identifier is None or instrument_type is None:
            acquisition_unmapped.append(f"{path}[missing-required]")
            return None
        record = {
            "identifier": _bounded_string(identifier, 1, 300, f"{path} identifier"),
            "type": _bounded_string(instrument_type, 1, 300, f"{path} type"),
        }
        description = _first_text(_direct_child(element, "description"), "CharacterString")
        if description:
            record["description"] = _bounded_string(description, 1, 1_000, f"{path} description")
        return record

    def acquisition_code(element: ET.Element, property_name: str, code_name: str) -> str | None:
        code = _first_element(_direct_child(element, property_name), code_name)
        if code is None:
            return None
        return code.attrib.get("codeListValue") or code.text

    def acquisition_party_names(element: ET.Element, property_name: str, path: str) -> list[str]:
        names: list[str] = []
        for index, scope in enumerate(_direct_children(element, property_name)):
            responsibility = _first_element(scope, "CI_Responsibility")
            organisation = _first_element(responsibility, "CI_Organisation")
            individual = _first_element(responsibility, "CI_Individual")
            party = organisation if organisation is not None else individual
            if party is None:
                acquisition_unmapped.append(f"{path}[{index}][missing-party]")
                continue
            name = _first_text(_direct_child(party, "name"), "CharacterString")
            if name:
                names.append(_bounded_string(name, 1, 300, f"{path}[{index}] party name"))
            else:
                acquisition_unmapped.append(f"{path}[{index}][missing-name]")
        return names

    def append_unique(records: list[dict[str, Any]], record: dict[str, Any]) -> None:
        if not any(existing["identifier"] == record["identifier"] for existing in records):
            records.append(record)

    def acquisition_event(element: ET.Element, path: str) -> dict[str, Any] | None:
        supported = {
            "identifier",
            "trigger",
            "context",
            "sequence",
            "time",
            "relatedPass",
            "relatedSensor",
            "expectedObjective",
        }
        acquisition_unmapped.extend(
            f"{path}.{name}"
            for name in sorted(
                {
                    _local_name(child.tag)
                    for child in element
                    if _local_name(child.tag) not in supported
                }
            )
        )
        identifier = _first_text(_direct_child(element, "identifier"), "CharacterString", "code")
        trigger = acquisition_code(element, "trigger", "MI_TriggerCode")
        context = acquisition_code(element, "context", "MI_ContextCode")
        sequence = acquisition_code(element, "sequence", "MI_SequenceCode")
        event_time = _first_text(_direct_child(element, "time"), "DateTime")
        if not all((identifier, trigger, context, sequence, event_time)):
            acquisition_unmapped.append(f"{path}[missing-required]")
            return None
        record: dict[str, Any] = {
            "identifier": _bounded_string(identifier, 1, 300, f"{path} identifier"),
            "trigger": _bounded_string(trigger, 1, 300, f"{path} trigger"),
            "context": _bounded_string(context, 1, 300, f"{path} context"),
            "sequence": _bounded_string(sequence, 1, 300, f"{path} sequence"),
            "time": _bounded_string(event_time, 1, 100, f"{path} time"),
        }
        pass_scope = _direct_child(element, "relatedPass")
        if pass_scope is not None:
            href = pass_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
            pass_identifier = (
                platform_pass_xml_ids.get(href[1:]) if href and href.startswith("#") else None
            )
            if pass_identifier is None:
                embedded_pass = _first_element(pass_scope, "MI_PlatformPass")
                embedded_record = (
                    acquisition_platform_pass(embedded_pass, f"{path}.relatedPass")
                    if embedded_pass is not None
                    else None
                )
                if embedded_record is not None:
                    append_unique(platform_passes, embedded_record)
                    pass_identifier = embedded_record["identifier"]
            if pass_identifier:
                record["passIdentifier"] = pass_identifier
            else:
                acquisition_unmapped.append(f"{path}.relatedPass[unresolved]")
        for property_name, field, reference_map, embedded_name in (
            ("relatedSensor", "instrumentIdentifiers", instrument_xml_ids, "MI_Instrument"),
            (
                "expectedObjective",
                "objectiveIdentifiers",
                objective_xml_ids,
                "MI_Objective",
            ),
        ):
            references: list[str] = []
            for reference_scope in _direct_children(element, property_name):
                href = reference_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
                referenced = reference_map.get(href[1:]) if href and href.startswith("#") else None
                if referenced:
                    references.append(referenced)
                elif _first_element(reference_scope, embedded_name) is not None:
                    acquisition_unmapped.append(f"{path}.{property_name}[embedded]")
                else:
                    acquisition_unmapped.append(f"{path}.{property_name}[unresolved]")
            if references:
                record[field] = list(dict.fromkeys(references))
        return record

    def acquisition_platform_pass(element: ET.Element, path: str) -> dict[str, Any] | None:
        supported = {"identifier", "relatedEvent"}
        acquisition_unmapped.extend(
            f"{path}.{name}"
            for name in sorted(
                {
                    _local_name(child.tag)
                    for child in element
                    if _local_name(child.tag) not in supported
                }
            )
        )
        identifier = _first_text(_direct_child(element, "identifier"), "CharacterString", "code")
        if identifier is None:
            acquisition_unmapped.append(f"{path}[missing-required]")
            return None
        record: dict[str, Any] = {
            "identifier": _bounded_string(identifier, 1, 300, f"{path} identifier")
        }
        references: list[str] = []
        for event_scope in _direct_children(element, "relatedEvent"):
            href = event_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
            referenced = event_xml_ids.get(href[1:]) if href and href.startswith("#") else None
            if referenced:
                references.append(referenced)
                continue
            embedded = _first_element(event_scope, "MI_Event")
            embedded_record = (
                acquisition_event(embedded, f"{path}.relatedEvent")
                if embedded is not None
                else None
            )
            if embedded_record is not None:
                append_unique(events, embedded_record)
                references.append(embedded_record["identifier"])
            else:
                acquisition_unmapped.append(f"{path}.relatedEvent[unresolved]")
        if references:
            record["eventIdentifiers"] = list(dict.fromkeys(references))
        return record

    for acquisition_scope in acquisition_scopes:
        information = _first_scope(acquisition_scope, "MI_AcquisitionInformation")
        if information is None:
            continue
        for element in information.iter():
            element_name = _local_name(element.tag)
            reference_map = {
                "MI_Operation": operation_xml_ids,
                "MI_Requirement": requirement_xml_ids,
                "MI_Objective": objective_xml_ids,
                "MI_PlatformPass": platform_pass_xml_ids,
                "MI_Event": event_xml_ids,
            }.get(element_name)
            if reference_map is None or not (xml_id := element.attrib.get("id")):
                continue
            identifier = _first_text(
                _direct_child(element, "identifier"), "CharacterString", "code"
            )
            if identifier:
                reference_map[xml_id] = _bounded_string(
                    identifier, 1, 300, f"ISO {element_name} identifier"
                )

    for acquisition_index, acquisition_scope in enumerate(acquisition_scopes):
        information = _first_scope(acquisition_scope, "MI_AcquisitionInformation")
        if information is None:
            acquisition_unmapped.append(f"acquisitionInformation[{acquisition_index}][unsupported]")
            continue
        for child_scope in information:
            child_name = _local_name(child_scope.tag)
            path = f"acquisitionInformation[{acquisition_index}].{child_name}"
            if child_name == "instrument":
                instrument_element = _first_element(child_scope, "MI_Instrument")
                if instrument_element is None:
                    acquisition_unmapped.append(f"{path}[reference-only]")
                    continue
                instrument = acquisition_instrument(instrument_element, path)
                if instrument is not None:
                    instruments.append(instrument)
                    xml_id = instrument_element.attrib.get("id")
                    if xml_id:
                        instrument_xml_ids[xml_id] = instrument["identifier"]
            elif child_name == "operation":
                operation_element = _first_element(child_scope, "MI_Operation")
                if operation_element is None:
                    acquisition_unmapped.append(f"{path}[reference-only]")
                    continue
                acquisition_unmapped.extend(
                    f"{path}.{name}"
                    for name in sorted(
                        {
                            _local_name(child.tag)
                            for child in operation_element
                            if _local_name(child.tag)
                            not in {
                                "description",
                                "identifier",
                                "status",
                                "type",
                                "significantEvent",
                            }
                        }
                    )
                )
                identifier = _first_text(
                    _direct_child(operation_element, "identifier"),
                    "CharacterString",
                    "code",
                )
                status_element = _first_element(
                    _direct_child(operation_element, "status"), "MD_ProgressCode"
                )
                status = (
                    status_element.attrib.get("codeListValue") or status_element.text
                    if status_element is not None
                    else None
                )
                if identifier is None or status is None:
                    acquisition_unmapped.append(f"{path}[missing-required]")
                    continue
                operation: dict[str, Any] = {
                    "identifier": _bounded_string(identifier, 1, 300, f"{path} identifier"),
                    "status": _bounded_string(status, 1, 300, f"{path} status"),
                }
                description = _first_text(
                    _direct_child(operation_element, "description"), "CharacterString"
                )
                if description:
                    operation["description"] = _bounded_string(
                        description, 1, 1_000, f"{path} description"
                    )
                operation_type_element = _first_element(
                    _direct_child(operation_element, "type"), "MI_OperationTypeCode"
                )
                operation_type = (
                    operation_type_element.attrib.get("codeListValue")
                    or operation_type_element.text
                    if operation_type_element is not None
                    else None
                )
                if operation_type:
                    operation["type"] = _bounded_string(operation_type, 1, 300, f"{path} type")
                event_references: list[str] = []
                for event_scope in _direct_children(operation_element, "significantEvent"):
                    href = event_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
                    referenced = (
                        event_xml_ids.get(href[1:]) if href and href.startswith("#") else None
                    )
                    if referenced is None:
                        embedded_event = _first_element(event_scope, "MI_Event")
                        embedded_record = (
                            acquisition_event(embedded_event, f"{path}.significantEvent")
                            if embedded_event is not None
                            else None
                        )
                        if embedded_record is not None:
                            append_unique(events, embedded_record)
                            referenced = embedded_record["identifier"]
                    if referenced:
                        event_references.append(referenced)
                    else:
                        acquisition_unmapped.append(f"{path}.significantEvent[unresolved]")
                if event_references:
                    operation["eventIdentifiers"] = list(dict.fromkeys(event_references))
                operations.append(operation)
            elif child_name == "platform":
                platform_element = _first_element(child_scope, "MI_Platform")
                if platform_element is None:
                    acquisition_unmapped.append(f"{path}[reference-only]")
                    continue
                acquisition_unmapped.extend(
                    f"{path}.{name}"
                    for name in sorted(
                        {
                            _local_name(child.tag)
                            for child in platform_element
                            if _local_name(child.tag)
                            not in {"identifier", "description", "instrument"}
                        }
                    )
                )
                identifier = _first_text(
                    _direct_child(platform_element, "identifier"),
                    "CharacterString",
                    "code",
                )
                description = _first_text(
                    _direct_child(platform_element, "description"), "CharacterString"
                )
                references: list[str] = []
                for instrument_scope in _direct_children(platform_element, "instrument"):
                    href = instrument_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
                    if href and href.startswith("#"):
                        referenced = instrument_xml_ids.get(href[1:])
                        if referenced:
                            references.append(referenced)
                            continue
                    embedded = _first_element(instrument_scope, "MI_Instrument")
                    if embedded is not None:
                        embedded_record = acquisition_instrument(embedded, f"{path}.instrument")
                        if embedded_record is not None:
                            existing = next(
                                (
                                    item
                                    for item in instruments
                                    if item["identifier"] == embedded_record["identifier"]
                                ),
                                None,
                            )
                            if existing is None:
                                instruments.append(embedded_record)
                            references.append(embedded_record["identifier"])
                            continue
                    acquisition_unmapped.append(f"{path}.instrument[unresolved]")
                if identifier is None or description is None or not references:
                    acquisition_unmapped.append(f"{path}[missing-required]")
                    continue
                platforms.append(
                    {
                        "identifier": _bounded_string(identifier, 1, 300, f"{path} identifier"),
                        "description": _bounded_string(
                            description, 1, 1_000, f"{path} description"
                        ),
                        "instrumentIdentifiers": list(dict.fromkeys(references)),
                    }
                )
            elif child_name == "acquisitionPlan":
                plan_element = _first_element(child_scope, "MI_Plan")
                if plan_element is None:
                    acquisition_unmapped.append(f"{path}[reference-only]")
                    continue
                acquisition_unmapped.extend(
                    f"{path}.{name}"
                    for name in sorted(
                        {
                            _local_name(child.tag)
                            for child in plan_element
                            if _local_name(child.tag)
                            not in {
                                "type",
                                "status",
                                "citation",
                                "operation",
                                "satisfiedRequirement",
                            }
                        }
                    )
                )
                identifier = _first_text(_direct_child(plan_element, "citation"), "CharacterString")
                status = acquisition_code(plan_element, "status", "MD_ProgressCode")
                if identifier is None or status is None:
                    acquisition_unmapped.append(f"{path}[missing-required]")
                    continue
                plan: dict[str, Any] = {
                    "identifier": _bounded_string(identifier, 1, 300, f"{path} citation title"),
                    "status": _bounded_string(status, 1, 300, f"{path} status"),
                }
                plan_type = acquisition_code(plan_element, "type", "MI_GeometryTypeCode")
                if plan_type:
                    plan["type"] = _bounded_string(plan_type, 1, 300, f"{path} type")
                for property_name, field, reference_map, embedded_name in (
                    (
                        "operation",
                        "operationIdentifiers",
                        operation_xml_ids,
                        "MI_Operation",
                    ),
                    (
                        "satisfiedRequirement",
                        "requirementIdentifiers",
                        requirement_xml_ids,
                        "MI_Requirement",
                    ),
                ):
                    references = []
                    for reference_scope in _direct_children(plan_element, property_name):
                        href = reference_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
                        referenced = (
                            reference_map.get(href[1:]) if href and href.startswith("#") else None
                        )
                        if referenced is None:
                            embedded = _first_element(reference_scope, embedded_name)
                            referenced = _first_text(
                                _direct_child(embedded, "identifier"),
                                "CharacterString",
                                "code",
                            )
                        if referenced:
                            references.append(
                                _bounded_string(
                                    referenced,
                                    1,
                                    300,
                                    f"{path}.{property_name} reference",
                                )
                            )
                        else:
                            acquisition_unmapped.append(f"{path}.{property_name}[unresolved]")
                    if references:
                        plan[field] = list(dict.fromkeys(references))
                plans.append(plan)
            elif child_name == "objective":
                objective_element = _first_element(child_scope, "MI_Objective")
                if objective_element is None:
                    acquisition_unmapped.append(f"{path}[reference-only]")
                    continue
                acquisition_unmapped.extend(
                    f"{path}.{name}"
                    for name in sorted(
                        {
                            _local_name(child.tag)
                            for child in objective_element
                            if _local_name(child.tag)
                            not in {
                                "identifier",
                                "priority",
                                "type",
                                "function",
                                "sensingInstrument",
                                "pass",
                                "objectiveOccurence",
                            }
                        }
                    )
                )
                identifiers = [
                    value
                    for identifier_scope in _direct_children(objective_element, "identifier")
                    if (value := _first_text(identifier_scope, "CharacterString", "code"))
                ]
                if not identifiers:
                    acquisition_unmapped.append(f"{path}[missing-required]")
                    continue
                if len(identifiers) > 1:
                    acquisition_unmapped.append(f"{path}.identifier[1:]")
                objective: dict[str, Any] = {
                    "identifier": _bounded_string(identifiers[0], 1, 300, f"{path} identifier")
                }
                priority = _first_text(
                    _direct_child(objective_element, "priority"), "CharacterString"
                )
                if priority:
                    objective["priority"] = _bounded_string(priority, 1, 300, f"{path} priority")
                objective_types: list[str] = []
                for type_scope in _direct_children(objective_element, "type"):
                    objective_type_code_element = _first_element(type_scope, "MI_ObjectiveTypeCode")
                    value = (
                        objective_type_code_element.attrib.get("codeListValue")
                        or objective_type_code_element.text
                        if objective_type_code_element is not None
                        else None
                    )
                    if value:
                        objective_types.append(_bounded_string(value, 1, 300, f"{path} type"))
                if objective_types:
                    objective["types"] = list(dict.fromkeys(objective_types))
                functions = [
                    _bounded_string(value, 1, 1_000, f"{path} function")
                    for function_scope in _direct_children(objective_element, "function")
                    if (value := _first_text(function_scope, "CharacterString"))
                ]
                if functions:
                    objective["functions"] = list(dict.fromkeys(functions))
                references = []
                for instrument_scope in _direct_children(objective_element, "sensingInstrument"):
                    href = instrument_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
                    referenced = (
                        instrument_xml_ids.get(href[1:]) if href and href.startswith("#") else None
                    )
                    if referenced:
                        references.append(referenced)
                    else:
                        acquisition_unmapped.append(f"{path}.sensingInstrument[unresolved]")
                if references:
                    objective["instrumentIdentifiers"] = list(dict.fromkeys(references))
                for property_name, field, reference_map, embedded_name, parser in (
                    (
                        "pass",
                        "passIdentifiers",
                        platform_pass_xml_ids,
                        "MI_PlatformPass",
                        acquisition_platform_pass,
                    ),
                    (
                        "objectiveOccurence",
                        "eventIdentifiers",
                        event_xml_ids,
                        "MI_Event",
                        acquisition_event,
                    ),
                ):
                    graph_references: list[str] = []
                    for graph_scope in _direct_children(objective_element, property_name):
                        href = graph_scope.attrib.get("{http://www.w3.org/1999/xlink}href")
                        referenced = (
                            reference_map.get(href[1:]) if href and href.startswith("#") else None
                        )
                        if referenced is None:
                            embedded = _first_element(graph_scope, embedded_name)
                            embedded_record = (
                                parser(embedded, f"{path}.{property_name}")
                                if embedded is not None
                                else None
                            )
                            if embedded_record is not None:
                                target_records = (
                                    platform_passes if field == "passIdentifiers" else events
                                )
                                append_unique(target_records, embedded_record)
                                referenced = embedded_record["identifier"]
                        if referenced:
                            graph_references.append(referenced)
                        else:
                            acquisition_unmapped.append(f"{path}.{property_name}[unresolved]")
                    if graph_references:
                        objective[field] = list(dict.fromkeys(graph_references))
                objectives.append(objective)
            elif child_name == "acquisitionRequirement":
                requirement_element = _first_element(child_scope, "MI_Requirement")
                if requirement_element is None:
                    acquisition_unmapped.append(f"{path}[reference-only]")
                    continue
                acquisition_unmapped.extend(
                    f"{path}.{name}"
                    for name in sorted(
                        {
                            _local_name(child.tag)
                            for child in requirement_element
                            if _local_name(child.tag)
                            not in {
                                "identifier",
                                "requestor",
                                "recipient",
                                "priority",
                                "requestedDate",
                                "expiryDate",
                            }
                        }
                    )
                )
                identifier = _first_text(
                    _direct_child(requirement_element, "identifier"),
                    "CharacterString",
                    "code",
                )
                requestors = acquisition_party_names(
                    requirement_element, "requestor", f"{path}.requestor"
                )
                recipients = acquisition_party_names(
                    requirement_element, "recipient", f"{path}.recipient"
                )
                priority = acquisition_code(requirement_element, "priority", "MI_PriorityCode")
                requested_date_element = _first_element(
                    _direct_child(requirement_element, "requestedDate"),
                    "MI_RequestedDate",
                )
                requested_date = _first_text(
                    _direct_child(requested_date_element, "requestedDateOfCollection"),
                    "DateTime",
                )
                latest_date = _first_text(
                    _direct_child(requested_date_element, "latestAcceptableDate"),
                    "DateTime",
                )
                expiry_date = _first_text(
                    _direct_child(requirement_element, "expiryDate"), "DateTime"
                )
                if not all(
                    (
                        identifier,
                        requestors,
                        recipients,
                        priority,
                        requested_date,
                        latest_date,
                        expiry_date,
                    )
                ):
                    acquisition_unmapped.append(f"{path}[missing-required]")
                    continue
                requirements.append(
                    {
                        "identifier": _bounded_string(identifier, 1, 300, f"{path} identifier"),
                        "requestors": requestors,
                        "recipients": recipients,
                        "priority": _bounded_string(priority, 1, 300, f"{path} priority"),
                        "requestedDate": {
                            "requestedDateOfCollection": _bounded_string(
                                requested_date,
                                1,
                                100,
                                f"{path} requested date",
                            ),
                            "latestAcceptableDate": _bounded_string(
                                latest_date,
                                1,
                                100,
                                f"{path} latest acceptable date",
                            ),
                        },
                        "expiryDate": _bounded_string(expiry_date, 1, 100, f"{path} expiry date"),
                    }
                )
            else:
                acquisition_unmapped.append(path)

    if (
        instruments
        or operations
        or platforms
        or plans
        or objectives
        or requirements
        or platform_passes
        or events
    ):
        acquisition = {
            key: value
            for key, value in (
                ("instruments", instruments),
                ("platformPasses", platform_passes),
                ("events", events),
                ("operations", operations),
                ("platforms", platforms),
                ("plans", plans),
                ("objectives", objectives),
                ("requirements", requirements),
            )
            if value
        }

    catalog: dict[str, Any] = {"schemaVersion": "1.0.0"}
    mapped: list[str] = []
    for catalog_value, target, source in (
        (contacts, "contacts", "mdb:contact"),
        (reference_systems, "referenceSystems", "mdb:referenceSystemInfo"),
        (distributions, "distributions", "mdb:distributionInfo"),
        (quality, "quality", "mdb:dataQualityInfo"),
        (lineage, "lineage", "mdb:resourceLineage"),
        (acquisition, "acquisition", "mdb:acquisitionInformation"),
    ):
        if catalog_value:
            catalog[target] = catalog_value
            mapped.append(f"{source}->metadata_extensions.opengeo.{target}")
    if acquisition:
        if platform_passes or events:
            catalog["schemaVersion"] = "1.3.0"
        elif plans or objectives or requirements:
            catalog["schemaVersion"] = "1.2.0"
        else:
            catalog["schemaVersion"] = "1.1.0"
    unmapped = ["distributionInfo[unsupported]"] if distribution_unmapped else []
    unmapped.extend(acquisition_unmapped)
    if len(lineage_scopes) > 1:
        unmapped.append("resourceLineage[1:]")
    return (catalog if len(catalog) > 1 else None), mapped, unmapped


def _iso_quality_scalar(value: str | None) -> str | int | float | bool | None:
    if value is None:
        return None
    normalized = value.strip()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    if len(normalized) <= 100 and re.fullmatch(r"-?(?:0|[1-9][0-9]*)", normalized):
        return int(normalized)
    if len(normalized) <= 100 and re.fullmatch(
        r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)", normalized
    ):
        result = float(normalized)
        return result if math.isfinite(result) else None
    if len(normalized) <= 100 and re.fullmatch(r"-?(?:0|[1-9][0-9]*)\.[0-9]+", normalized):
        result = float(normalized)
        return result if math.isfinite(result) else None
    return normalized or None


def _direct_children(root: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in root if _local_name(child.tag) == name]


def _direct_child(root: ET.Element | None, name: str) -> ET.Element | None:
    if root is None:
        return None
    return next((child for child in root if _local_name(child.tag) == name), None)


def _parse_safe_iso_xml(document: str) -> ET.Element:
    encoded = document.encode("utf-8")
    if not 2 <= len(encoded) <= MAX_SOURCE_BYTES:
        raise MetadataImportInvalid("ISO XML source document exceeds 49152 UTF-8 bytes")
    lowered = document.casefold()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise MetadataImportInvalid("ISO XML source must not contain DTD or entity declarations")
    try:
        root = ET.fromstring(document)
    except ET.ParseError as error:
        raise MetadataImportInvalid("ISO XML source is not well formed") from error
    if root.tag != ("{http://standards.iso.org/iso/19115/-3/mdb/2.0}MD_Metadata"):
        raise MetadataImportInvalid(
            "ISO XML root must be the ISO 19115-3:2023 mdb:MD_Metadata element"
        )
    nodes = 0
    stack: list[tuple[ET.Element, int]] = [(root, 0)]
    while stack:
        element, depth = stack.pop()
        nodes += 1
        if nodes > 2_000:
            raise MetadataImportInvalid("ISO XML source has too many elements")
        if depth > 32:
            raise MetadataImportInvalid("ISO XML source is too deeply nested")
        if len(element.attrib) > 20 or any(
            len(key) > 300 or len(value) > 2_000 for key, value in element.attrib.items()
        ):
            raise MetadataImportInvalid("ISO XML attributes exceed bounded limits")
        if element.text is not None and len(element.text) > 16_384:
            raise MetadataImportInvalid("ISO XML text exceeds bounded limits")
        stack.extend((child, depth + 1) for child in element)
    return root


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _first_element(root: ET.Element | None, name: str) -> ET.Element | None:
    if root is None:
        return None
    return next((element for element in root.iter() if _local_name(element.tag) == name), None)


def _first_scope(root: ET.Element | None, name: str) -> ET.Element | None:
    return _first_element(root, name)


def _first_text(root: ET.Element | None, *names: str) -> str | None:
    if root is None:
        return None
    accepted = set(names)
    for element in root.iter():
        if _local_name(element.tag) in accepted and element.text and element.text.strip():
            return element.text.strip()
    return None


def _texts_in_scopes(root: ET.Element | None, scope: str, value_name: str) -> list[str]:
    if root is None:
        return []
    values: list[str] = []
    for element in root.iter():
        if _local_name(element.tag) != scope:
            continue
        value = _first_text(element, value_name)
        if value is not None:
            values.append(value)
    return values


def _iso_decimal(root: ET.Element | None, scope: str) -> float | None:
    element = _first_scope(root, scope)
    raw = _first_text(element, "Decimal")
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError as error:
        raise MetadataImportInvalid(f"ISO {scope} is invalid") from error
    return value


def _iso_spatial(root: ET.Element | None) -> tuple[float, float, float, float] | None:
    bbox_scope = _first_scope(root, "EX_GeographicBoundingBox")
    if bbox_scope is None:
        return None
    values = (
        _iso_decimal(bbox_scope, "westBoundLongitude"),
        _iso_decimal(bbox_scope, "southBoundLatitude"),
        _iso_decimal(bbox_scope, "eastBoundLongitude"),
        _iso_decimal(bbox_scope, "northBoundLatitude"),
    )
    if any(value is None for value in values):
        raise MetadataImportInvalid("ISO geographic bounding box is incomplete")
    return _bbox(cast(tuple[float, float, float, float], values), "ISO geographic bounding box")


def _iso_temporal(root: ET.Element | None) -> tuple[datetime | None, datetime | None]:
    period = _first_scope(root, "TimePeriod")
    if period is None:
        return None, None
    start = _optional_datetime(_first_text(period, "beginPosition"), "ISO temporal start")
    end = _optional_datetime(_first_text(period, "endPosition"), "ISO temporal end")
    _temporal_order(start, end)
    return start, end


def _dcat_localized_values(
    value: Any, maximum: int, label: str, *, optional: bool = False
) -> list[tuple[str, str | None]]:
    if value is None and optional:
        return []
    values = value if isinstance(value, list) else [value]
    if not 1 <= len(values) <= 9:
        raise MetadataImportInvalid(f"{label} must contain 1 to 9 localized values")
    parsed: list[tuple[str, str | None]] = []
    for item in values:
        if isinstance(item, str):
            parsed.append((_bounded_string(item, 1, maximum, label), None))
        elif isinstance(item, dict) and set(item) <= {"@value", "@language"}:
            item_language = _language(item["@language"]).lower() if "@language" in item else None
            parsed.append((_bounded_string(item.get("@value"), 1, maximum, label), item_language))
        else:
            raise MetadataImportInvalid(f"{label} must be a string or language-tagged value")
    languages = [item_language for _, item_language in parsed]
    if len(languages) != len(set(languages)):
        raise MetadataImportInvalid(f"{label} languages must be unique")
    return parsed


def _dcat_languages(value: Any) -> list[str]:
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    if not 1 <= len(values) <= 9:
        raise MetadataImportInvalid("DCAT languages must contain 1 to 9 values")
    languages = [_language(item).lower() for item in values]
    if len(languages) != len(set(languages)):
        raise MetadataImportInvalid("DCAT languages must be unique")
    return languages


def _dcat_localized_keywords(value: Any) -> list[tuple[str, str | None]]:
    if value is None:
        return []
    values = [value] if isinstance(value, str | dict) else value
    if not isinstance(values, list) or len(values) > 64:
        raise MetadataImportInvalid("DCAT keywords must contain at most 64 values")
    result: list[tuple[str, str | None]] = []
    for item in values:
        if isinstance(item, str):
            result.append((_bounded_string(item, 1, 100, "DCAT keyword"), None))
        elif isinstance(item, dict) and set(item) <= {"@value", "@language"}:
            item_language = _language(item["@language"]).lower() if "@language" in item else None
            result.append(
                (
                    _bounded_string(item.get("@value"), 1, 100, "DCAT keyword"),
                    item_language,
                )
            )
        else:
            raise MetadataImportInvalid("DCAT keywords must be strings or language-tagged values")
    keys = [(value.casefold(), item_language) for value, item_language in result]
    if len(keys) != len(set(keys)):
        raise MetadataImportInvalid("DCAT keywords must be unique within each language")
    return result


def _primary_localized_value(values: list[tuple[str, str | None]], language: str) -> str | None:
    matching = [value for value, item_language in values if item_language == language]
    untagged = [value for value, item_language in values if item_language is None]
    selected = matching or untagged
    return selected[0] if selected else None


def _dcat_extent(value: Any) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("@type") != "dct:Location":
        raise MetadataImportInvalid("DCAT spatial extent must be a dct:Location")
    geometry = value.get("locn:geometry")
    if not isinstance(geometry, dict) or not isinstance(geometry.get("@value"), str):
        raise MetadataImportInvalid("DCAT spatial extent must contain WKT geometry")
    match = _WKT_POLYGON.fullmatch(geometry["@value"])
    if match is None:
        raise MetadataImportInvalid("DCAT spatial extent must be a WKT polygon")
    pairs = [item.strip().split() for item in match.group(1).split(",")]
    if len(pairs) != 5 or any(len(pair) != 2 for pair in pairs):
        raise MetadataImportInvalid("DCAT spatial polygon must be one rectangular ring")
    try:
        points = [(float(pair[0]), float(pair[1])) for pair in pairs]
    except ValueError as error:
        raise MetadataImportInvalid("DCAT spatial polygon coordinates are invalid") from error
    finite = all(math.isfinite(item) for point in points for item in point)
    if points[0] != points[-1] or not finite:
        raise MetadataImportInvalid("DCAT spatial polygon must be finite and closed")
    xs = {point[0] for point in points[:-1]}
    ys = {point[1] for point in points[:-1]}
    if len(xs) != 2 or len(ys) != 2 or set(points[:-1]) != {(x, y) for x in xs for y in ys}:
        raise MetadataImportInvalid("DCAT spatial polygon must be an axis-aligned rectangle")
    return _bbox((min(xs), min(ys), max(xs), max(ys)), "DCAT spatial extent")


def _dcat_temporal(value: Any) -> tuple[datetime | None, datetime | None]:
    if value is None:
        return None, None
    if not isinstance(value, dict) or value.get("@type") != "dct:PeriodOfTime":
        raise MetadataImportInvalid("DCAT temporal extent must be a dct:PeriodOfTime")
    start = _optional_datetime(value.get("dcat:startDate"), "DCAT start date")
    end = _optional_datetime(value.get("dcat:endDate"), "DCAT end date")
    _temporal_order(start, end)
    return start, end


def _stac_spatial(extent: Any) -> tuple[tuple[float, float, float, float], list[str]]:
    if not isinstance(extent, dict) or not isinstance(extent.get("spatial"), dict):
        raise MetadataImportInvalid("STAC spatial extent is required")
    boxes = extent["spatial"].get("bbox")
    if not isinstance(boxes, list) or not 1 <= len(boxes) <= 100:
        raise MetadataImportInvalid("STAC spatial bbox must contain 1 to 100 boxes")
    parsed = [_bbox(item, "STAC spatial bbox") for item in boxes]
    union = (
        min(item[0] for item in parsed),
        min(item[1] for item in parsed),
        max(item[2] for item in parsed),
        max(item[3] for item in parsed),
    )
    return union, ["multiple spatial bboxes unioned"] if len(parsed) > 1 else []


def _stac_temporal(extent: Any) -> tuple[datetime | None, datetime | None, list[str]]:
    if not isinstance(extent, dict) or not isinstance(extent.get("temporal"), dict):
        raise MetadataImportInvalid("STAC temporal extent is required")
    intervals = extent["temporal"].get("interval")
    if not isinstance(intervals, list) or not 1 <= len(intervals) <= 100:
        raise MetadataImportInvalid("STAC temporal interval must contain 1 to 100 intervals")
    starts: list[datetime] = []
    ends: list[datetime] = []
    start_open = False
    end_open = False
    for interval in intervals:
        if not isinstance(interval, list) or len(interval) != 2:
            raise MetadataImportInvalid("STAC temporal intervals must contain two values")
        start = _optional_datetime(interval[0], "STAC interval start")
        end = _optional_datetime(interval[1], "STAC interval end")
        _temporal_order(start, end)
        start_open = start_open or start is None
        end_open = end_open or end is None
        if start is not None:
            starts.append(start)
        if end is not None:
            ends.append(end)
    union_start = None if start_open else min(starts)
    union_end = None if end_open else max(ends)
    return (
        union_start,
        union_end,
        ["multiple temporal intervals unioned"] if len(intervals) > 1 else [],
    )


def _bbox(value: Any, label: str) -> tuple[float, float, float, float]:
    if (
        not isinstance(value, list | tuple)
        or len(value) != 4
        or any(isinstance(item, bool) or not isinstance(item, int | float) for item in value)
    ):
        raise MetadataImportInvalid(f"{label} must be a four-number EPSG:4326 bbox")
    result = cast(tuple[float, float, float, float], tuple(float(item) for item in value))
    min_x, min_y, max_x, max_y = result
    if not all(math.isfinite(item) for item in result) or not (
        -180 <= min_x <= max_x <= 180 and -90 <= min_y <= max_y <= 90
    ):
        raise MetadataImportInvalid(f"{label} must be an ordered EPSG:4326 bbox")
    return result


def _keywords(value: Any, label: str) -> tuple[str, ...]:
    values = [value] if isinstance(value, str) else value
    if not isinstance(values, list) or len(values) > 64:
        raise MetadataImportInvalid(f"{label} must contain at most 64 strings")
    result = tuple(_bounded_string(item, 1, 100, label) for item in values)
    if len({item.casefold() for item in result}) != len(result):
        raise MetadataImportInvalid(f"{label} must be unique")
    return result


def _language(value: Any) -> str:
    language = _bounded_string(value, 2, 40, "metadata language")
    if _LANGUAGE.fullmatch(language) is None:
        raise MetadataImportInvalid("metadata language is invalid")
    return language


def _optional_string(value: Any, maximum: int, label: str) -> str | None:
    return None if value is None else _bounded_string(value, 1, maximum, label)


def _bounded_string(value: Any, minimum: int, maximum: int, label: str) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise MetadataImportInvalid(f"{label} must be a bounded non-empty string")
    return value.strip()


def _optional_datetime(value: Any, label: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 100:
        raise MetadataImportInvalid(f"{label} must be an ISO 8601 timestamp or null")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise MetadataImportInvalid(f"{label} must be an ISO 8601 timestamp") from error
    if parsed.tzinfo is None:
        raise MetadataImportInvalid(f"{label} must include a timezone")
    return parsed


def _temporal_order(start: datetime | None, end: datetime | None) -> None:
    if start is not None and end is not None and start > end:
        raise MetadataImportInvalid("metadata temporal start must not exceed its end")


def _reject_sensitive_url(value: str) -> None:
    if not value.startswith(("http://", "https://")):
        return
    parsed = urlsplit(value)
    if parsed.username is not None or parsed.password is not None:
        raise MetadataImportInvalid("metadata source URLs must not contain credentials")
    query_names = (name for name, _ in parse_qsl(parsed.query, keep_blank_values=True))
    if any(_SENSITIVE_NAME.search(name) for name in query_names):
        raise MetadataImportInvalid(
            "metadata source URLs must not contain signed or secret queries"
        )
