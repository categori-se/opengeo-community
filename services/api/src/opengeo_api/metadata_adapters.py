import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from typing import Any, cast
from urllib.parse import parse_qsl, urlsplit
from uuid import UUID

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.metadata_catalog import (
    ISO_QUALITY_EVALUATION_TYPES,
    ISO_QUALITY_REPORT_TYPES,
    CatalogMetadataInvalid,
    _iso_medium,
    _quality_id,
    validate_catalog_extensions,
)
from opengeo_api.metadata_profiles import (
    _DATACITE_REGISTRATION_VOCABULARIES,
    _ISO_COUNTRY_CODELIST,
    _iso_primary_locale,
    _iso_quality_unit_label_supported,
)
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
    title_candidates: list[tuple[int, str, str | None, Any]] = []
    unmapped_titles: list[str] = []
    for index, item in enumerate(titles):
        if not isinstance(item, dict):
            raise MetadataImportInvalid("DataCite titles must be objects")
        value = _bounded_string(item.get("title"), 1, 16_384, "DataCite retained title")
        item_language = _language(item["lang"]).lower() if "lang" in item else None
        title_type = item.get("titleType")
        title_candidates.append((index, value, item_language, title_type))
        if title_type is not None and title_type != "TranslatedTitle":
            unmapped_titles.append(
                f"data.attributes.titles[{index}].titleType[retained-not-native-main]"
            )
    selected_titles: dict[str | None, tuple[int, str]] = {}
    for wanted_type in (None, "TranslatedTitle"):
        for index, value, item_language, title_type in title_candidates:
            if title_type != wanted_type:
                continue
            if item_language not in selected_titles:
                selected_titles[item_language] = (index, value)
            else:
                unmapped_titles.append(
                    f"data.attributes.titles[{index}][retained-native-title-variant]"
                )
    title_fallback = not selected_titles
    if title_fallback:
        index, value, item_language, _ = title_candidates[0]
        selected_titles[item_language] = (index, value)
        unmapped_titles.append(f"data.attributes.titles[{index}][legacy-first-title-fallback]")
    title_values = [
        (_bounded_string(value, 1, 300, "DataCite native title"), item_language)
        for item_language, (_, value) in sorted(
            selected_titles.items(), key=lambda item: item[1][0]
        )
    ]
    descriptions = attributes.get("descriptions", [])
    if not isinstance(descriptions, list) or len(descriptions) > 9:
        raise MetadataImportInvalid("DataCite descriptions must contain at most 9 values")
    description_values: list[tuple[str, str | None]] = []
    unmapped_descriptions: list[str] = []
    description_languages: set[str | None] = set()
    for index, item in enumerate(descriptions):
        if not isinstance(item, dict):
            raise MetadataImportInvalid("DataCite descriptions must be objects")
        if item.get("descriptionType") != "Abstract":
            unmapped_descriptions.append(f"data.attributes.descriptions[{index}]")
            continue
        item_language = _language(item["lang"]).lower() if "lang" in item else None
        if item_language in description_languages:
            unmapped_descriptions.append(
                f"data.attributes.descriptions[{index}][retained-native-abstract-variant]"
            )
            continue
        description_values.append(
            (
                _bounded_string(item.get("description"), 1, 8_000, "DataCite abstract"),
                item_language,
            )
        )
        description_languages.add(item_language)
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
    native_date_unmapped: list[str] = []
    try:
        temporal_start, temporal_end = _datacite_temporal(attributes.get("dates", []))
    except MetadataImportInvalid:
        temporal_start, temporal_end = None, None
        raw_dates = attributes.get("dates")
        if isinstance(raw_dates, list):
            native_date_unmapped.extend(
                f"data.attributes.dates[{index}].date[native-temporal-projection-unsupported]"
                for index, value in enumerate(raw_dates)
                if isinstance(value, dict) and value.get("dateType") == "Coverage"
            )
        if not native_date_unmapped:
            native_date_unmapped.append(
                "data.attributes.dates[native-temporal-projection-unsupported]"
            )
    resource_type = attributes.get("types")
    general = resource_type.get("resourceTypeGeneral") if isinstance(resource_type, dict) else None
    if (
        not isinstance(general, str)
        or general not in _DATACITE_REGISTRATION_VOCABULARIES["resourceType"]
    ):
        raise MetadataImportInvalid("DataCite resourceTypeGeneral is unsupported")
    native_kind: ResourceKind = (
        "dataset"
        if general in {"Dataset", "Collection"}
        else "service"
        if general == "Service"
        else "document"
    )
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
        "relatedItems",
        "alternateIdentifiers",
        "formats",
        "sizes",
        "fundingReferences",
        "schemaVersion",
    }
    extensions = {
        "datacite": {key: attributes[key] for key in sorted(known_attributes) if key in attributes}
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
    for source, target, actually_mapped in (
        (
            "descriptions",
            "abstract/translations",
            abstract is not None or any("abstract" in value for value in translations.values()),
        ),
        ("rightsList", "license", license_value is not None),
        ("geoLocations", "spatial_extent", spatial_extent is not None),
        ("dates", "temporal_extent", temporal_start is not None or temporal_end is not None),
    ):
        if source in attributes and actually_mapped:
            mapped.append(f"data.attributes.{source}->{target}")
    unmapped = [
        *(f"data.{key}" for key in sorted(set(data) - {"id", "type", "attributes"})),
        *(f"data.attributes.{key}" for key in sorted(set(attributes) - known_attributes)),
        *unmapped_descriptions,
        *native_date_unmapped,
        *unmapped_titles,
        *multilingual_unmapped,
        *catalog_contact_unmapped,
        *catalog_funding_unmapped,
    ]
    defaulted = [] if attributes.get("language") or title_values[0][1] else ["language=en"]
    if title_fallback:
        defaulted.append("native.title=first-retained-title (no main or TranslatedTitle)")
    for key in sorted(known_attributes & attributes.keys()):
        mapped.append(f"data.attributes.{key}->metadata_extensions.datacite.{key}")
    primary_title_index = (
        selected_titles[language][0]
        if language in selected_titles
        else selected_titles[None][0]
        if None in selected_titles
        else min(index for index, _ in selected_titles.values())
    )
    for item_language, (index, _) in selected_titles.items():
        if index == primary_title_index:
            mapped.append(f"data.attributes.titles[{index}].title->title")
        elif item_language is not None and item_language != language:
            mapped.append(
                f"data.attributes.titles[{index}].title->translations.{item_language}.title"
            )
        else:
            unmapped.append(f"data.attributes.titles[{index}][retained-not-selected-native-title]")
    report = _report("datacite_4_7", mapped, defaulted, sorted(unmapped), [])
    return _plan(
        source_format="datacite_4_7",
        source_version=DATACITE_VERSION,
        namespace=namespace,
        identifier=identifier,
        checksum=checksum,
        document=document,
        report=report,
        kind=native_kind,
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
    language_code = _first_element(_first_scope(root, "defaultLocale"), "LanguageCode")
    language_value = (
        language_code.attrib.get("codeListValue") or language_code.text
        if language_code is not None
        else None
    )
    language = _language(language_value or "en").lower()
    primary_locale_mapped: list[str] = []
    primary_locale_unmapped: list[str] = []
    if "-" in language:
        # Keep legacy/native compound tags exact; never call a script a country.
        primary_locale_unmapped.append("mdb:defaultLocale.LanguageCode[compound-tag-preserved]")
    mdb = "{http://standards.iso.org/iso/19115/-3/mdb/2.0}"
    lan = "{http://standards.iso.org/iso/19115/-3/lan/1.0}"
    primary_locales = root.findall(f"{mdb}defaultLocale/{lan}PT_Locale")
    country_scopes = [
        country
        for locale in primary_locales
        for country in locale
        if _local_name(country.tag) == "country"
    ]
    if country_scopes:
        country_codes = list(country_scopes[0])
        primary_codes = (
            primary_locales[0].findall(f"{lan}language/{lan}LanguageCode")
            if len(primary_locales) == 1
            else []
        )
        country_code = (
            country_codes[0]
            if len(primary_locales) == 1
            and len(primary_codes) == 1
            and primary_codes[0] is language_code
            and len(country_scopes) == 1
            and country_scopes[0].tag == f"{lan}country"
            and len(country_codes) == 1
            and country_codes[0].tag == f"{lan}CountryCode"
            else None
        )
        country_value = (
            country_code.get("codeListValue") or country_code.text
            if country_code is not None
            else None
        )
        mapped_locale = (
            _iso_primary_locale(f"{language}-{country_value}")
            if language_value is not None
            and country_code is not None
            and country_code.get("codeList") == _ISO_COUNTRY_CODELIST
            else None
        )
        if mapped_locale is not None and mapped_locale[1] is not None:
            language = f"{mapped_locale[0]}-{mapped_locale[1].lower()}"
            primary_locale_mapped.append("mdb:defaultLocale.CountryCode->language.region")
            primary_locale_mapped.append("language.case->lowercase_native_tag")
        else:
            primary_locale_unmapped.append("mdb:defaultLocale.country")
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
    translations, localized_unmapped = _iso_translations(root, identification, language)
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
    mapped.extend(primary_locale_mapped)
    if translations:
        mapped.append("lan:PT_FreeText->translations")
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
            ("dataQualityInfo", "qualityReports"),
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
        )
        if name in root_names and name not in mapped_root_sections
    ]
    explicitly_unmapped.extend(catalog_unmapped)
    explicitly_unmapped.extend(localized_unmapped)
    explicitly_unmapped.extend(primary_locale_unmapped)
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
        translations=translations,
        spatial_extent=spatial_extent,
        temporal_start=temporal_start,
        temporal_end=temporal_end,
        managed_profile_id=managed_profile_id,
        managed_profile_version=managed_profile_version,
        metadata_profile=metadata_profile,
        extensions=extensions,
    )


def _iso_translations(
    root: ET.Element, identification: ET.Element | None, language: str
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    lan = "{http://standards.iso.org/iso/19115/-3/lan/1.0}"
    mdb = "{http://standards.iso.org/iso/19115/-3/mdb/2.0}"
    mri = "{http://standards.iso.org/iso/19115/-3/mri/1.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    srv = "{http://standards.iso.org/iso/19115/-3/srv/2.0}"
    locales: dict[str, str | None] = {}
    unmapped: list[str] = []
    for scope_name in ("defaultLocale", "otherLocale"):
        for scope in root.findall(f"{mdb}{scope_name}/{lan}PT_Locale"):
            identifier = scope.get("id")
            if not identifier:
                continue
            reference = f"#{identifier}"
            code = scope.find(f"{lan}language/{lan}LanguageCode")
            try:
                value = _language(
                    code.get("codeListValue") or code.text if code is not None else None
                ).lower()
                if "-" in value:
                    # BCP 47 locale tags require separate country/script mapping.
                    value = None
            except MetadataImportInvalid:
                value = None
            if reference in locales:
                locales[reference] = None
            else:
                locales[reference] = value
            if scope.find(f"{lan}country") is not None:
                # A country is not necessarily a BCP 47 region; never guess a tag.
                locales[reference] = None

    localized = [
        node for node in root.iter() if _local_name(node.tag) == "LocalisedCharacterString"
    ]
    labels = {node: f"LocalisedCharacterString[{index}]" for index, node in enumerate(localized)}
    values: dict[str, dict[str, Any]] = {}
    consumed: set[ET.Element] = set()
    data_identification = None
    if identification is not None and identification.tag == f"{mdb}identificationInfo":
        data_identification = next(
            (
                node
                for node in identification
                if node.tag in {f"{mri}MD_DataIdentification", f"{srv}SV_ServiceIdentification"}
            ),
            None,
        )
    if data_identification is not None:
        scopes = [
            (data_identification.find(f"{mri}citation/{cit}CI_Citation/{cit}title"), "title", 300),
            (data_identification.find(f"{mri}abstract"), "abstract", 8_000),
            (data_identification.find(f"{mri}credit"), "attribution", 2_000),
            *[
                (scope, "keywords", 100)
                for scope in data_identification.findall(
                    f"{mri}descriptiveKeywords/{mri}MD_Keywords/{mri}keyword"
                )
            ],
        ]
        for scope, field, maximum in scopes:
            if scope is None:
                continue
            localized_path = f"{lan}PT_FreeText/{lan}textGroup/{lan}LocalisedCharacterString"
            for node in scope.findall(localized_path):
                translated_language = locales.get(node.get("locale", ""))
                if translated_language is None or translated_language == language or len(node):
                    continue
                value = _bounded_string(node.text, 1, maximum, f"ISO translated {field}")
                translation = values.setdefault(translated_language, {})
                if field == "keywords":
                    translation.setdefault(field, []).append(value)
                elif field in translation:
                    raise MetadataImportInvalid(
                        f"ISO translated {field} has multiple values for one language"
                    )
                else:
                    translation[field] = value
                consumed.add(node)
    translations = {key: value for key, value in values.items() if "title" in value}
    for node in localized:
        translated_language = locales.get(node.get("locale", ""))
        if node not in consumed or translated_language not in translations:
            unmapped.append(labels[node])
    if len(translations) > 8:
        raise MetadataImportInvalid("ISO translations exceed 8 languages")
    for translation in translations.values():
        if "keywords" in translation:
            translation["keywords"] = list(
                _keywords(translation["keywords"], "ISO translated keywords")
            )
    if len(canonical_json_bytes(translations)) > 16_384:
        raise MetadataImportInvalid("ISO translations exceed 16384 canonical bytes")
    return translations, unmapped


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
    distribution_unmapped: list[str] = []

    quality: list[dict[str, Any]] = []
    quality_unit_mapped: list[str] = []
    quality_unit_unmapped: list[str] = []

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
    mac = "{http://standards.iso.org/iso/19115/-3/mac/2.0}"
    mdb = "{http://standards.iso.org/iso/19115/-3/mdb/2.0}"
    cit = "{http://standards.iso.org/iso/19115/-3/cit/2.0}"
    mcc = "{http://standards.iso.org/iso/19115/-3/mcc/1.0}"
    gco = "{http://standards.iso.org/iso/19115/-3/gco/1.0}"
    href_attribute = "{http://www.w3.org/1999/xlink}href"
    xml_id_nodes: dict[str, list[ET.Element]] = {}
    for node in root.iter():
        for attribute in (
            "id",
            "{http://www.opengis.net/gml/3.2}id",
            "{http://www.w3.org/XML/1998/namespace}id",
        ):
            if xml_id := node.get(attribute):
                xml_id_nodes.setdefault(xml_id, []).append(node)
    inverse_plan_records: dict[ET.Element, dict[str, Any]] = {}
    inverse_plan_references: list[tuple[ET.Element, str, str, bool]] = []
    inverse_plan_mapped = False
    acquisition_context_mapped: list[str] = []
    acquisition_context_entries: list[tuple[str, str]] = []
    acquisition_context_blocks: list[tuple[dict[str, Any], str, list[tuple[str, str]]]] = []
    acquisition_context_owner: dict[str, Any] = {}
    environmental_conditions: dict[str, Any] | None = None
    gex = "{http://standards.iso.org/iso/19115/-3/gex/1.0}"
    gml = "{http://www.opengis.net/gml/3.2}"
    plan_identity_space = "urn:opengeo:catalog:acquisition-plan"
    parent_nodes = {child: parent for parent in root.iter() for child in parent}

    context_unmapped = acquisition_unmapped

    def context_loss(path: str) -> None:
        context_unmapped.append(f"{path}[unsupported]")

    def context_owner(element: ET.Element, name: str) -> bool:
        if element.tag != f"{mac}{name}":
            return False
        node = element
        while (parent := parent_nodes.get(node)) is not None:
            if parent is root:
                return node.tag == f"{mdb}acquisitionInformation"
            if parent.tag == f"{mdb}acquisitionInformation":
                if parent.attrib or list(parent) != [node]:
                    return False
            elif not parent.tag.startswith(mac) or (
                not _local_name(parent.tag).startswith("MI_")
                and (parent.attrib or list(parent) != [node])
            ):
                return False
            node = parent
        return False

    def context_properties(element: ET.Element, name: str) -> list[ET.Element]:
        return [child for child in element if _local_name(child.tag) == name]

    def context_property(element: ET.Element, tag: str, path: str) -> ET.Element | None:
        properties = context_properties(element, _local_name(tag))
        if not properties:
            return None
        if len(properties) != 1 or properties[0].tag != tag:
            context_loss(path)
            return None
        return properties[0]

    def context_embedded(
        scope: ET.Element | None,
        tag: str,
        path: str,
        attributes: set[str] | None = None,
    ) -> ET.Element | None:
        if (
            scope is None
            or scope.attrib
            or (scope.text or "").strip()
            or len(scope) != 1
            or (scope[0].tail or "").strip()
            or scope[0].tag != tag
            or set(scope[0].attrib) - (attributes or set())
        ):
            context_loss(path)
            return None
        return scope[0]

    def context_unknown(element: ET.Element, tags: set[str], path: str) -> None:
        if (element.text or "").strip():
            context_loss(f"{path}.text")
        for index, child in enumerate(element):
            if child.tag not in tags:
                context_loss(f"{path}.{_local_name(child.tag)}[{index}]")
            if (child.tail or "").strip():
                context_loss(f"{path}.{_local_name(child.tag)}[{index}].tail")

    def context_text(
        element: ET.Element, property_tag: str, value_tag: str, path: str, maximum: int
    ) -> str | None:
        scope = context_property(element, property_tag, path)
        if scope is None:
            return None
        value = context_embedded(scope, value_tag, path)
        raw = value.text if value is not None else None
        if (
            value is None
            or len(value)
            or raw is None
            or raw != raw.strip()
            or not 1 <= len(raw) <= maximum
            or not _iso_quality_unit_label_supported(raw)
        ):
            context_loss(path)
            return None
        return raw

    def context_number(
        element: ET.Element, property_tag: str, value_tag: str, path: str
    ) -> int | float | None:
        raw = context_text(element, property_tag, value_tag, path, 16_384)
        if raw is None:
            return None
        number_pattern = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
        if value_tag == f"{gco}Real":
            number_pattern += r"(?:[eE][+-]?\d+)?"
        if re.fullmatch(number_pattern, raw) is None:
            context_loss(path)
            return None
        try:
            value = float(raw)
        except ValueError:
            context_loss(path)
            return None
        if not math.isfinite(value):
            context_loss(path)
            return None
        try:
            exact = Decimal(raw)
            if re.fullmatch(r"[+-]?\d+", raw) is not None:
                return int(exact)
            lossless = Decimal(str(value)) == exact
            if not lossless and exact == exact.to_integral_value():
                return int(exact)
        except InvalidOperation:
            lossless = False
        if not lossless:
            context_loss(path)
            return None
        return value

    def context_datetime(raw: str | None, path: str) -> str | None:
        if raw is None:
            return None
        if len(raw) > 100:
            context_loss(path)
            return None
        pattern = (
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?"
            r"(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)"
        )
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            offset = parsed.utcoffset()
            valid = (
                re.fullmatch(pattern, raw) is not None
                and offset is not None
                and abs(offset.total_seconds()) <= 14 * 60 * 60
            )
        except ValueError:
            valid = False
        if not valid:
            context_loss(path)
            return None
        return raw

    def context_time_key(value: str) -> tuple[datetime, str]:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        fraction = re.search(r"\.(\d+)", value)
        return parsed.replace(microsecond=0), (fraction.group(1) if fraction else "").rstrip("0")

    def context_mapped(
        value: Any,
        path: str,
        target: str,
        *,
        owner: dict[str, Any] | None = None,
        key: str | None = None,
    ) -> None:
        start = len(acquisition_context_entries)
        if isinstance(value, dict):
            for field, child in value.items():
                context_mapped(child, f"{path}.{field}", f"{target}.{field}")
        elif isinstance(value, list):
            for index, child in enumerate(value):
                context_mapped(child, f"{path}[{index}]", f"{target}[{index}]")
        else:
            acquisition_context_mapped.append(f"{path}->{target}")
            acquisition_context_entries.append((path, target))
        if owner is not None and key is not None:
            entries = acquisition_context_entries[start:]
            for block_owner, block_key, block_entries in acquisition_context_blocks:
                if block_owner is owner and block_key == key:
                    block_entries.extend(entries)
                    break
            else:
                acquisition_context_blocks.append((owner, key, entries))

    def context_extent(scope: ET.Element, path: str) -> dict[str, Any] | None:
        extent = context_embedded(scope, f"{gex}EX_Extent", path)
        if extent is None:
            return None
        context_unknown(
            extent,
            {f"{gex}description", f"{gex}geographicElement", f"{gex}temporalElement"},
            path,
        )
        record: dict[str, Any] = {}
        description = context_text(
            extent, f"{gex}description", f"{gco}CharacterString", f"{path}.description", 1000
        )
        if description is not None:
            record["description"] = description
        boxes: list[dict[str, Any]] = []
        for index, geographic in enumerate(context_properties(extent, "geographicElement")):
            box_path = f"{path}.geographicElement[{index}]"
            if index >= 4 or geographic.tag != f"{gex}geographicElement":
                context_loss(box_path)
                continue
            box = context_embedded(geographic, f"{gex}EX_GeographicBoundingBox", box_path)
            if box is None:
                continue
            names = {
                "west": ("westBoundLongitude", -180, 180),
                "east": ("eastBoundLongitude", -180, 180),
                "south": ("southBoundLatitude", -90, 90),
                "north": ("northBoundLatitude", -90, 90),
            }
            context_unknown(
                box,
                {f"{gex}{v[0]}" for v in names.values()} | {f"{gex}extentTypeCode"},
                box_path,
            )
            bounds: dict[str, Any] = {}
            for key, (name, minimum, maximum) in names.items():
                number = context_number(box, f"{gex}{name}", f"{gco}Decimal", f"{box_path}.{name}")
                if number is not None and minimum <= number <= maximum:
                    bounds[key] = number
                else:
                    context_loss(f"{box_path}.{name}")
            if len(bounds) != 4 or bounds["south"] > bounds["north"]:
                context_loss(box_path)
                continue
            inclusion = context_text(
                box, f"{gex}extentTypeCode", f"{gco}Boolean", f"{box_path}.extentTypeCode", 5
            )
            if inclusion in {"true", "false", "1", "0"}:
                bounds["extentTypeCode"] = inclusion in {"true", "1"}
            elif inclusion is not None:
                context_loss(f"{box_path}.extentTypeCode")
            boxes.append(bounds)
        if boxes:
            record["geographicBounds"] = boxes
        temporal_scopes = context_properties(extent, "temporalElement")
        if temporal_scopes:
            temporal_path = f"{path}.temporalElement"
            temporal = (
                context_embedded(temporal_scopes[0], f"{gex}EX_TemporalExtent", temporal_path)
                if len(temporal_scopes) == 1 and temporal_scopes[0].tag == f"{gex}temporalElement"
                else None
            )
            period = None
            if (
                temporal is not None
                and len(temporal) == 1
                and not (temporal.text or "").strip()
                and not (temporal[0].tail or "").strip()
            ):
                period_scope = context_property(temporal, f"{gex}extent", temporal_path)
                period = context_embedded(
                    period_scope, f"{gml}TimePeriod", temporal_path, {f"{gml}id"}
                )
            if period is not None:
                period_id = period.get(f"{gml}id")
                if (
                    not period_id
                    or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", period_id) is None
                    or len(xml_id_nodes.get(period_id, [])) != 1
                    or (period.text or "").strip()
                    or any((child.tail or "").strip() for child in period)
                    or len(period) != 2
                    or {child.tag for child in period}
                    != {f"{gml}beginPosition", f"{gml}endPosition"}
                ):
                    period = None
            dates: dict[str, str] = {}
            if period is not None:
                for key, tag in (("start", "beginPosition"), ("end", "endPosition")):
                    nodes = period.findall(f"{gml}{tag}")
                    node = nodes[0] if len(nodes) == 1 else None
                    raw = (
                        node.text
                        if node is not None and not node.attrib and not len(node)
                        else None
                    )
                    date = context_datetime(raw, f"{temporal_path}.{tag}")
                    if date is not None:
                        dates[key] = date
            if len(dates) == 2 and context_time_key(dates["start"]) <= context_time_key(
                dates["end"]
            ):
                record["temporal"] = dates
            else:
                context_loss(temporal_path)
        if not record:
            context_loss(path)
        return record or None

    def context_citation(
        element: ET.Element, path: str, *, plan: bool = False, property_tag: str | None = None
    ) -> tuple[dict[str, Any] | None, str | None, bool]:
        citation_tag = property_tag or f"{mac}citation"
        scope = context_property(element, citation_tag, path)
        if scope is None:
            return None, None, bool(context_properties(element, _local_name(citation_tag)))
        citation = context_embedded(scope, f"{cit}CI_Citation", path)
        if citation is None:
            return None, None, True
        context_unknown(
            citation,
            {
                f"{cit}{name}"
                for name in (
                    "title",
                    "alternateTitle",
                    "date",
                    "edition",
                    "editionDate",
                    "identifier",
                )
            },
            path,
        )
        title = context_text(
            citation, f"{cit}title", f"{gco}CharacterString", f"{path}.title", 1000
        )
        if title is None:
            context_loss(f"{path}.title")
            return None, None, True
        record: dict[str, Any] = {"title": title}
        alternatives: list[str] = []
        for index, alternate in enumerate(context_properties(citation, "alternateTitle")):
            alternate_path = f"{path}.alternateTitle[{index}]"
            value = context_embedded(alternate, f"{gco}CharacterString", alternate_path)
            raw = value.text if value is not None and not len(value) else None
            if (
                index >= 8
                or alternate.tag != f"{cit}alternateTitle"
                or raw is None
                or raw != raw.strip()
                or not 1 <= len(raw) <= 1000
                or not _iso_quality_unit_label_supported(raw)
            ):
                context_loss(alternate_path)
            else:
                alternatives.append(raw)
        if alternatives:
            record["alternateTitles"] = alternatives
        dates: list[dict[str, str]] = []
        for index, date_scope in enumerate(context_properties(citation, "date")):
            date_path = f"{path}.date[{index}]"
            date = context_embedded(date_scope, f"{cit}CI_Date", date_path)
            if index >= 8 or date_scope.tag != f"{cit}date" or date is None:
                context_loss(date_path)
                continue
            context_unknown(date, {f"{cit}date", f"{cit}dateType"}, date_path)
            raw = context_text(date, f"{cit}date", f"{gco}Date", f"{date_path}.date", 10)
            type_scope = context_property(date, f"{cit}dateType", f"{date_path}.dateType")
            type_node = context_embedded(
                type_scope,
                f"{cit}CI_DateTypeCode",
                f"{date_path}.dateType",
                {"codeList", "codeListValue"},
            )
            date_type = type_node.get("codeListValue") if type_node is not None else None
            try:
                valid_date = raw is not None and re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw) is not None
                if valid_date:
                    datetime.fromisoformat(raw)
            except ValueError:
                valid_date = False
            if (
                not valid_date
                or date_type not in {"creation", "publication", "revision"}
                or type_node is None
                or len(type_node)
                or (type_node.text or "").strip() not in {"", date_type}
            ):
                context_loss(date_path)
            elif raw is not None and date_type is not None:
                dates.append({"date": raw, "dateType": date_type})
        if dates:
            record["dates"] = dates
        edition = context_text(
            citation, f"{cit}edition", f"{gco}CharacterString", f"{path}.edition", 300
        )
        if edition is not None:
            record["edition"] = edition
        edition_date = context_datetime(
            context_text(
                citation, f"{cit}editionDate", f"{gco}DateTime", f"{path}.editionDate", 100
            ),
            f"{path}.editionDate",
        )
        if edition_date is not None:
            record["editionDate"] = edition_date
        identifiers: list[dict[str, str]] = []
        carriers: list[str] = []
        invalid_carrier = False
        for index, identifier_scope in enumerate(context_properties(citation, "identifier")):
            identifier_path = f"{path}.identifier[{index}]"
            carrier_shape = any(
                _local_name(child.tag) == "codeSpace"
                and any((node.text or "").strip() == plan_identity_space for node in child.iter())
                for child in identifier_scope.iter()
            )
            identifier = context_embedded(identifier_scope, f"{mcc}MD_Identifier", identifier_path)
            value: dict[str, str] = {}
            if identifier_scope.tag == f"{cit}identifier" and identifier is not None:
                context_unknown(identifier, {f"{mcc}code", f"{mcc}codeSpace"}, identifier_path)
                code = context_text(
                    identifier,
                    f"{mcc}code",
                    f"{gco}CharacterString",
                    f"{identifier_path}.code",
                    300,
                )
                code_space = context_text(
                    identifier,
                    f"{mcc}codeSpace",
                    f"{gco}CharacterString",
                    f"{identifier_path}.codeSpace",
                    300,
                )
                if code is not None:
                    value["code"] = code
                if code_space is not None:
                    value["codeSpace"] = code_space
            if carrier_shape:
                if (
                    not plan
                    or set(value) != {"code", "codeSpace"}
                    or value["codeSpace"] != plan_identity_space
                    or identifier is None
                    or len(identifier) != 2
                ):
                    invalid_carrier = True
                    context_loss(f"{identifier_path}.planIdentity")
                else:
                    carriers.append(value["code"])
            elif "code" not in value or len(identifiers) >= 8 or value in identifiers:
                context_loss(identifier_path)
            else:
                identifiers.append(value)
        if len(carriers) > 1:
            invalid_carrier = True
            context_loss(f"{path}.planIdentity[ambiguous]")
        if identifiers:
            record["identifiers"] = identifiers
        return record, carriers[0] if len(carriers) == 1 else None, invalid_carrier

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
        supported = {"identifier", "relatedEvent", "extent"}
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
        extent_scopes = context_properties(element, "extent")
        if extent_scopes:
            extent = (
                context_extent(extent_scopes[0], f"{path}.extent")
                if context_owner(element, "MI_PlatformPass")
                and len(extent_scopes) == 1
                and extent_scopes[0].tag == f"{mac}extent"
                else None
            )
            if extent is None:
                context_loss(f"{path}.extent")
            elif not any(
                existing["identifier"] == record["identifier"] for existing in platform_passes
            ):
                record["extent"] = extent
                context_mapped(
                    extent,
                    f"{path}.extent",
                    "metadata_extensions.opengeo.acquisition.platformPasses"
                    f"[{len(platform_passes)}].extent",
                    owner=record,
                    key="extent",
                )
            else:
                context_loss(f"{path}.extent[duplicate-pass]")
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
                citation, carrier, invalid_identity = context_citation(
                    plan_element, f"{path}.citation", plan=True
                )
                if invalid_identity:
                    context_loss(f"{path}.planIdentity")
                    continue
                identifier = carrier or (citation["title"] if citation is not None else None)
                status = acquisition_code(plan_element, "status", "MD_ProgressCode")
                if identifier is None or status is None or len(identifier) > 300:
                    if identifier is not None and len(identifier) > 300:
                        context_loss(f"{path}.citation.title[plan-identity-too-long]")
                    acquisition_unmapped.append(f"{path}[missing-required]")
                    continue
                plan: dict[str, Any] = {
                    "identifier": _bounded_string(identifier, 1, 300, f"{path} citation title"),
                    "status": _bounded_string(status, 1, 300, f"{path} status"),
                }
                plan_type = acquisition_code(plan_element, "type", "MI_GeometryTypeCode")
                if plan_type:
                    plan["type"] = _bounded_string(plan_type, 1, 300, f"{path} type")
                if citation is not None and (carrier is not None or len(citation) > 1):
                    if context_owner(plan_element, "MI_Plan"):
                        plan["citation"] = citation
                        context_mapped(
                            citation,
                            f"{path}.citation",
                            f"metadata_extensions.opengeo.acquisition.plans[{len(plans)}].citation",
                            owner=plan,
                            key="citation",
                        )
                        if carrier is not None:
                            acquisition_context_mapped.append(
                                f"{path}.citation.identifier[planIdentity]->"
                                f"metadata_extensions.opengeo.acquisition.plans[{len(plans)}].identifier"
                            )
                    else:
                        context_loss(f"{path}.citation")
                        if carrier is not None:
                            context_loss(f"{path}.planIdentity")
                            continue
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
                citation_titles = plan_element.findall(
                    f"{mac}citation/{cit}CI_Citation/{cit}title/{gco}CharacterString"
                )
                if (
                    acquisition_scope.tag == f"{mdb}acquisitionInformation"
                    and information.tag == f"{mac}MI_AcquisitionInformation"
                    and child_scope.tag == f"{mac}acquisitionPlan"
                    and not child_scope.attrib
                    and list(child_scope) == [plan_element]
                    and plan_element.tag == f"{mac}MI_Plan"
                    and len(citation_titles) == 1
                    and citation is not None
                    and (citation_titles[0].text or "").strip() == citation["title"]
                ):
                    inverse_plan_records[plan_element] = plan
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
                                "extent",
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
                extents: list[dict[str, Any]] = []
                for extent_index, extent_scope in enumerate(
                    context_properties(objective_element, "extent")
                ):
                    extent_path = f"{path}.extent[{extent_index}]"
                    extent = (
                        context_extent(extent_scope, extent_path)
                        if extent_index < 4
                        and context_owner(objective_element, "MI_Objective")
                        and extent_scope.tag == f"{mac}extent"
                        else None
                    )
                    if extent is None:
                        context_loss(extent_path)
                    else:
                        context_mapped(
                            extent,
                            extent_path,
                            f"metadata_extensions.opengeo.acquisition.objectives[{len(objectives)}]"
                            f".extents[{len(extents)}]",
                            owner=objective,
                            key="extents",
                        )
                        extents.append(extent)
                if extents:
                    objective["extents"] = extents
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
                                "citation",
                                "identifier",
                                "requestor",
                                "recipient",
                                "priority",
                                "requestedDate",
                                "expiryDate",
                                "satisifiedPlan",
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
                if context_properties(requirement_element, "citation"):
                    citation, _, _ = context_citation(requirement_element, f"{path}.citation")
                    if citation is not None and context_owner(
                        requirement_element, "MI_Requirement"
                    ):
                        requirements[-1]["citation"] = citation
                        context_mapped(
                            citation,
                            f"{path}.citation",
                            "metadata_extensions.opengeo.acquisition.requirements"
                            f"[{len(requirements) - 1}].citation",
                            owner=requirements[-1],
                            key="citation",
                        )
                    else:
                        context_loss(f"{path}.citation")
                identifier_codes = requirement_element.findall(
                    f"{mac}identifier/{mcc}MD_Identifier/{mcc}code/{gco}CharacterString"
                )
                canonical_requirement = (
                    acquisition_scope.tag == f"{mdb}acquisitionInformation"
                    and information.tag == f"{mac}MI_AcquisitionInformation"
                    and child_scope.tag == f"{mac}acquisitionRequirement"
                    and not child_scope.attrib
                    and list(child_scope) == [requirement_element]
                    and requirement_element.tag == f"{mac}MI_Requirement"
                    and len(identifier_codes) == 1
                    and (identifier_codes[0].text or "").strip() == requirements[-1]["identifier"]
                )
                inverse_plan_references.extend(
                    (scope, requirements[-1]["identifier"], path, canonical_requirement)
                    for scope in requirement_element
                    if _local_name(scope.tag) == "satisifiedPlan"
                )
            elif child_name == "environmentalConditions":
                environment_path = f"{path}.MI_EnvironmentalRecord"
                candidates = [
                    child
                    for scope in acquisition_scopes
                    for info in scope
                    if scope.tag == f"{mdb}acquisitionInformation"
                    and info.tag == f"{mac}MI_AcquisitionInformation"
                    for child in info
                    if _local_name(child.tag) == "environmentalConditions"
                ]
                environment = (
                    context_embedded(child_scope, f"{mac}MI_EnvironmentalRecord", environment_path)
                    if len(candidates) == 1
                    and child_scope.tag == f"{mac}environmentalConditions"
                    and acquisition_scope.tag == f"{mdb}acquisitionInformation"
                    and context_owner(information, "MI_AcquisitionInformation")
                    else None
                )
                if environment is None:
                    context_loss(environment_path)
                    continue
                names = (
                    "averageAirTemperature",
                    "maxRelativeHumidity",
                    "maxAltitude",
                    "meterologicalConditions",
                    "solarAzimuth",
                    "solarElevation",
                )
                context_unknown(environment, {f"{mac}{name}" for name in names}, environment_path)
                values: dict[str, Any] = {}
                for name in names:
                    value_path = f"{environment_path}.{name}"
                    if name == "meterologicalConditions":
                        value: Any = context_text(
                            environment, f"{mac}{name}", f"{gco}CharacterString", value_path, 1000
                        )
                        native_name = "meteorologicalConditions"
                    else:
                        value = context_number(
                            environment, f"{mac}{name}", f"{gco}Real", value_path
                        )
                        native_name = name
                    if value is not None:
                        values[native_name] = value
                if values:
                    environmental_conditions = values
                    acquisition_context_owner["environmentalConditions"] = values
                    context_mapped(
                        values,
                        environment_path,
                        "metadata_extensions.opengeo.acquisition.environmentalConditions",
                        owner=acquisition_context_owner,
                        key="environmentalConditions",
                    )
                else:
                    context_loss(environment_path)
            else:
                acquisition_unmapped.append(path)

    for scope, requirement_identifier, path, canonical_requirement in inverse_plan_references:
        href = scope.get(href_attribute)
        targets = xml_id_nodes.get(href[1:], []) if href and href.startswith("#") else []
        plan_record = inverse_plan_records.get(targets[0]) if len(targets) == 1 else None
        if (
            canonical_requirement
            and scope.tag == f"{mac}satisifiedPlan"
            and scope.attrib == {href_attribute: href}
            and href is not None
            and re.fullmatch(r"#[A-Za-z_][A-Za-z0-9_.-]*", href) is not None
            and not len(scope)
            and not (scope.text or "").strip()
            and plan_record is not None
        ):
            references = plan_record.setdefault("requirementIdentifiers", [])
            if requirement_identifier not in references:
                references.append(requirement_identifier)
            inverse_plan_mapped = True
        else:
            acquisition_unmapped.append(f"{path}.satisifiedPlan[unsupported]")

    if (
        instruments
        or operations
        or platforms
        or plans
        or objectives
        or requirements
        or platform_passes
        or events
        or environmental_conditions
    ):
        acquisition = acquisition_context_owner
        acquisition.update(
            {
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
        )

    # Distribution and acquisition share strict citation/scalar readers. Keep losses
    # with their owning domain rather than guessing associations by descendant order.
    context_unmapped = distribution_unmapped
    mrd = "{http://standards.iso.org/iso/19115/-3/mrd/1.0}"
    for distribution_index, distribution_scope in enumerate(
        context_properties(root, "distributionInfo")
    ):
        distribution_path = f"mdb:distributionInfo[{distribution_index}]"
        owner = (
            context_embedded(distribution_scope, f"{mrd}MD_Distribution", distribution_path)
            if distribution_scope.tag == f"{mdb}distributionInfo"
            else None
        )
        if owner is None:
            context_loss(distribution_path)
            continue
        context_unknown(owner, {f"{mrd}transferOptions"}, distribution_path)
        for transfer_index, transfer_scope in enumerate(
            context_properties(owner, "transferOptions")
        ):
            path = f"{distribution_path}.transferOptions[{transfer_index}]"
            transfer = (
                context_embedded(transfer_scope, f"{mrd}MD_DigitalTransferOptions", path)
                if transfer_scope.tag == f"{mrd}transferOptions"
                else None
            )
            if transfer is None or len(distributions) >= 32:
                context_loss(path)
                continue
            context_unknown(
                transfer,
                {
                    f"{mrd}{name}"
                    for name in (
                        "unitsOfDistribution",
                        "transferSize",
                        "onLine",
                        "offLine",
                        "transferFrequency",
                        "distributionFormat",
                    )
                },
                path,
            )
            retained: dict[str, Any] = {}
            for name, target, scalar, maximum in (
                ("unitsOfDistribution", "unitsOfDistribution", "CharacterString", 1000),
                ("transferSize", "transferSizeMegabytes", "Real", 100),
                ("transferFrequency", "transferFrequency", "TM_PeriodDuration", 100),
            ):
                raw = context_text(
                    transfer, f"{mrd}{name}", f"{gco}{scalar}", f"{path}.{name}", maximum
                )
                if raw is None:
                    continue
                if name == "transferSize":
                    numeric = context_number(
                        transfer, f"{mrd}{name}", f"{gco}Real", f"{path}.{name}"
                    )
                    if numeric is None or numeric <= 0:
                        context_loss(f"{path}.{name}")
                        continue
                    retained[target] = numeric
                else:
                    try:
                        validate_catalog_extensions(
                            {
                                "opengeo": {
                                    "schemaVersion": "1.5.0",
                                    "distributions": [
                                        {
                                            "accessUrl": "https://example.test/",
                                            "isoTransfer": {target: raw},
                                        }
                                    ],
                                }
                            }
                        )
                    except CatalogMetadataInvalid:
                        context_loss(f"{path}.{name}")
                        continue
                    retained[target] = raw
            online_records: list[dict[str, Any]] = []
            for online_index, scope in enumerate(context_properties(transfer, "onLine")):
                online_path = f"{path}.onLine[{online_index}]"
                online = (
                    context_embedded(scope, f"{cit}CI_OnlineResource", online_path)
                    if scope.tag == f"{mrd}onLine"
                    else None
                )
                if online is None or len(online_records) >= 8:
                    context_loss(online_path)
                    continue
                context_unknown(
                    online,
                    {
                        f"{cit}{name}"
                        for name in (
                            "linkage",
                            "protocol",
                            "applicationProfile",
                            "name",
                            "description",
                            "function",
                            "protocolRequest",
                        )
                    },
                    online_path,
                )
                record = {}
                for name in (
                    "linkage",
                    "protocol",
                    "applicationProfile",
                    "name",
                    "description",
                    "protocolRequest",
                ):
                    raw = context_text(
                        online,
                        f"{cit}{name}",
                        f"{gco}CharacterString",
                        f"{online_path}.{name}",
                        2048 if name == "linkage" else 1000,
                    )
                    if raw is not None:
                        record[name] = raw
                function_scope = context_property(
                    online, f"{cit}function", f"{online_path}.function"
                )
                if function_scope is None and context_properties(online, "function"):
                    context_loss(f"{online_path}.function")
                    continue
                if function_scope is not None:
                    node = context_embedded(
                        function_scope,
                        f"{cit}CI_OnLineFunctionCode",
                        f"{online_path}.function",
                        {"codeList", "codeListValue"},
                    )
                    code = node.get("codeListValue") if node is not None else None
                    if (
                        node is None
                        or len(node)
                        or not code
                        or len(code) > 300
                        or code != code.strip()
                        or (node.text or "").strip() not in {"", code}
                        or not _iso_quality_unit_label_supported(code)
                    ):
                        context_loss(f"{online_path}.function")
                        continue
                    else:
                        record["function"] = code
                if "linkage" not in record:
                    context_loss(f"{online_path}.linkage")
                    continue
                try:
                    validate_catalog_extensions(
                        {
                            "opengeo": {
                                "schemaVersion": "1.5.0",
                                "distributions": [
                                    {
                                        "accessUrl": record["linkage"],
                                        "isoTransfer": {"onlineResources": [record]},
                                    }
                                ],
                            }
                        }
                    )
                except CatalogMetadataInvalid:
                    context_loss(online_path)
                    continue
                online_records.append(record)
            if online_records:
                retained["onlineResources"] = online_records
            offline_records: list[dict[str, Any]] = []
            for media_index, media_scope in enumerate(context_properties(transfer, "offLine")):
                media_path = f"{path}.offLine[{media_index}]"
                medium = (
                    context_embedded(media_scope, f"{mrd}MD_Medium", media_path)
                    if media_scope.tag == f"{mrd}offLine"
                    else None
                )
                if medium is None or media_index >= 8:
                    context_loss(media_path)
                    continue
                context_unknown(
                    medium,
                    {
                        f"{mrd}{name}"
                        for name in (
                            "name",
                            "density",
                            "densityUnits",
                            "volumes",
                            "mediumFormat",
                            "mediumNote",
                            "identifier",
                        )
                    },
                    media_path,
                )
                media_record: dict[str, Any] = {}
                media_name, _, _ = context_citation(
                    medium, f"{media_path}.name", property_tag=f"{mrd}name"
                )
                if media_name is not None:
                    media_record["name"] = media_name
                for field, scalar, maximum in (
                    ("density", "Real", 100),
                    ("densityUnits", "CharacterString", 1000),
                    ("volumes", "Integer", 100),
                    ("mediumNote", "CharacterString", 1000),
                ):
                    field_path = f"{media_path}.{field}"
                    raw = context_text(
                        medium, f"{mrd}{field}", f"{gco}{scalar}", field_path, maximum
                    )
                    if raw is None:
                        continue
                    media_value: str | int = raw
                    if field == "volumes":
                        if re.fullmatch(r"[+-]?[0-9]+", raw) is None:
                            context_loss(field_path)
                            continue
                        media_value = int(raw)
                    try:
                        media_record.update(_iso_medium({field: media_value}, media_path))
                    except CatalogMetadataInvalid:
                        context_loss(field_path)
                media_formats: list[str] = []
                for code_index, code_scope in enumerate(context_properties(medium, "mediumFormat")):
                    code_path = f"{media_path}.mediumFormat[{code_index}]"
                    code_node = (
                        context_embedded(
                            code_scope,
                            f"{mrd}MD_MediumFormatCode",
                            code_path,
                            {"codeList", "codeListValue"},
                        )
                        if code_scope.tag == f"{mrd}mediumFormat"
                        else None
                    )
                    code = code_node.get("codeListValue") if code_node is not None else None
                    if (
                        code_index >= 8
                        or code_node is None
                        or len(code_node)
                        or code_node.get("codeList")
                        != "https://schemas.isotc211.org/resources/codelists/codelists.xml#MD_MediumFormatCode"
                        or not code
                        or code != code.strip()
                        or (code_node.text or "").strip() not in {"", code}
                    ):
                        context_loss(code_path)
                        continue
                    try:
                        _iso_medium({"mediumFormats": [code]}, media_path)
                    except CatalogMetadataInvalid:
                        context_loss(code_path)
                        continue
                    media_formats.append(code)
                if media_formats:
                    media_record["mediumFormats"] = media_formats
                identifier_scope = context_property(
                    medium, f"{mrd}identifier", f"{media_path}.identifier"
                )
                if identifier_scope is not None:
                    identifier_node = context_embedded(
                        identifier_scope, f"{mcc}MD_Identifier", f"{media_path}.identifier"
                    )
                    if identifier_node is not None:
                        identifier_path = f"{media_path}.identifier"
                        context_unknown(
                            identifier_node, {f"{mcc}code", f"{mcc}codeSpace"}, identifier_path
                        )
                        identifier: dict[str, str] = {}
                        for field in ("code", "codeSpace"):
                            raw = context_text(
                                identifier_node,
                                f"{mcc}{field}",
                                f"{gco}CharacterString",
                                f"{identifier_path}.{field}",
                                300,
                            )
                            if raw is not None:
                                identifier[field] = raw
                        try:
                            media_record.update(_iso_medium({"identifier": identifier}, media_path))
                        except CatalogMetadataInvalid:
                            context_loss(identifier_path)
                if media_record:
                    offline_records.append(media_record)
                else:
                    context_loss(media_path)
            if offline_records:
                retained["offlineMedia"] = offline_records
            format_records: list[dict[str, Any]] = []
            for format_index, scope in enumerate(
                context_properties(transfer, "distributionFormat")
            ):
                format_path = f"{path}.distributionFormat[{format_index}]"
                format_element = (
                    context_embedded(scope, f"{mrd}MD_Format", format_path)
                    if scope.tag == f"{mrd}distributionFormat"
                    else None
                )
                if format_element is None or len(format_records) >= 8:
                    context_loss(format_path)
                    continue
                context_unknown(
                    format_element,
                    {
                        f"{mrd}{name}"
                        for name in (
                            "formatSpecificationCitation",
                            "amendmentNumber",
                            "fileDecompressionTechnique",
                        )
                    },
                    format_path,
                )
                citation, _, _ = context_citation(
                    format_element,
                    f"{format_path}.citation",
                    property_tag=f"{mrd}formatSpecificationCitation",
                )
                if citation is None:
                    context_loss(format_path)
                    continue
                format_record: dict[str, Any] = {"citation": citation}
                for name in ("amendmentNumber", "fileDecompressionTechnique"):
                    raw = context_text(
                        format_element,
                        f"{mrd}{name}",
                        f"{gco}CharacterString",
                        f"{format_path}.{name}",
                        1000,
                    )
                    if raw is not None:
                        format_record[name] = raw
                format_records.append(format_record)
            if format_records:
                retained["formats"] = format_records
            distribution: dict[str, Any] = {}
            bindings: dict[str, int] = {}
            for online_index, online_record in enumerate(online_records):
                function = online_record.get("function")
                target = (
                    "downloadUrl"
                    if function == "download"
                    else "accessUrl"
                    if function in {None, "information"}
                    else None
                )
                if target is not None and target not in distribution:
                    distribution[target] = online_record["linkage"]
                    bindings[target] = online_index
            if not distribution and not offline_records:
                context_loss(f"{path}[no-supported-access-projection]")
                continue
            title_index = bindings.get("accessUrl", bindings.get("downloadUrl"))
            if title_index is not None and "name" in online_records[title_index]:
                distribution["title"] = online_records[title_index]["name"]
                bindings["title"] = title_index
            if format_records:
                distribution["format"] = format_records[0]["citation"]["title"]
                bindings["format"] = 0
            if bindings:
                retained["projections"] = bindings
            distribution["isoTransfer"] = retained
            try:
                normalized = validate_catalog_extensions(
                    {
                        "opengeo": {
                            "schemaVersion": "1.7.0" if offline_records else "1.5.0",
                            "distributions": [distribution],
                        }
                    }
                )
            except CatalogMetadataInvalid:
                context_loss(path)
                continue
            distributions.extend(normalized["opengeo"]["distributions"])

    # Strict typed quality parsing shares the citation readers and ownership rules.
    context_unmapped = quality_unit_unmapped
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    quality_groups: list[dict[str, Any]] = []
    quality_refs: list[tuple[dict[str, Any], str, str, str]] = []
    quality_report_nodes: dict[int, ET.Element] = {}

    def quality_text(
        element: ET.Element,
        name: str,
        path: str,
        maximum: int = 1000,
        scalar: str = "CharacterString",
    ) -> str | None:
        return context_text(element, f"{mdq}{name}", f"{gco}{scalar}", f"{path}.{name}", maximum)

    def quality_code(
        element: ET.Element, namespace: str, name: str, code_name: str, path: str
    ) -> str | None:
        prop = context_property(element, f"{namespace}{name}", f"{path}.{name}")
        if prop is None:
            return None
        node = context_embedded(
            prop, f"{namespace}{code_name}", f"{path}.{name}", {"codeList", "codeListValue"}
        )
        raw = node.get("codeListValue") if node is not None else None
        if (
            node is None
            or len(node)
            or not raw
            or raw != raw.strip()
            or len(raw) > 300
            or (node.text or "").strip() not in {"", raw}
        ):
            context_loss(f"{path}.{name}")
            return None
        return raw

    def quality_scope(element: ET.Element, name: str, path: str) -> dict[str, str] | None:
        prop = context_property(element, f"{mdq}{name}", f"{path}.{name}")
        node = context_embedded(prop, f"{mcc}MD_Scope", f"{path}.{name}")
        if node is None:
            return None
        context_unknown(node, {f"{mcc}level"}, f"{path}.{name}")
        level_value = quality_code(node, mcc, "level", "MD_ScopeCode", f"{path}.{name}")
        return {"level": level_value} if level_value is not None else None

    def quality_citation(element: ET.Element, name: str, path: str) -> dict[str, Any] | None:
        value, _, _ = context_citation(element, f"{path}.{name}", property_tag=f"{mdq}{name}")
        return value

    def quality_result(element: ET.Element, path: str, report: ET.Element) -> dict[str, Any] | None:
        kind = _local_name(element.tag)
        if element.tag != f"{mdq}{kind}" or kind not in {
            "DQ_QuantitativeResult",
            "DQ_DescriptiveResult",
            "DQ_ConformanceResult",
        }:
            context_loss(path)
            return None
        allowed = {"dateTime", "resultScope"} | (
            {"value", "valueUnit", "valueRecordType"}
            if kind == "DQ_QuantitativeResult"
            else {"statement"}
            if kind == "DQ_DescriptiveResult"
            else {"specification", "explanation", "pass"}
        )
        context_unknown(element, {f"{mdq}{name}" for name in allowed}, path)
        value: dict[str, Any] = {"type": kind}
        if context_properties(element, "dateTime"):
            stamp = context_datetime(
                quality_text(element, "dateTime", path, 100, "DateTime"), f"{path}.dateTime"
            )
            if stamp is not None:
                value["dateTime"] = stamp
        if context_properties(element, "resultScope"):
            scope_value = quality_scope(element, "resultScope", path)
            if scope_value is not None:
                value["scope"] = scope_value
        if kind == "DQ_DescriptiveResult":
            statement = quality_text(element, "statement", path)
            if statement is None:
                context_loss(f"{path}.statement")
                return None
            value["statement"] = statement
        elif kind == "DQ_ConformanceResult":
            citation = quality_citation(element, "specification", path)
            raw_pass = quality_text(element, "pass", path, 5, "Boolean")
            if citation is None or raw_pass not in {"true", "false", "1", "0"}:
                context_loss(path)
                return None
            value.update(specification=citation, **{"pass": raw_pass in {"true", "1"}})
            explanation = quality_text(element, "explanation", path)
            if explanation is not None:
                value["explanation"] = explanation
        else:
            records: list[str] = []
            for index, prop in enumerate(context_properties(element, "value")):
                record_path = f"{path}.value[{index}]"
                node = (
                    context_embedded(prop, f"{gco}Record", record_path)
                    if prop.tag == f"{mdq}value"
                    else None
                )
                raw = node.text if node is not None and not len(node) else None
                if (
                    index >= 8
                    or raw is None
                    or raw != raw.strip()
                    or not 1 <= len(raw) <= 1000
                    or not _iso_quality_unit_label_supported(raw)
                ):
                    context_loss(record_path)
                else:
                    records.append(raw)
            if not records:
                context_loss(f"{path}.value")
                return None
            value["values"] = records
            units = context_properties(element, "valueUnit")
            if units:
                label = _iso_quality_unit(root, report, element, units, allow_multiple=True)
                if label is None:
                    context_loss(f"{path}.valueUnit")
                else:
                    value["unit"] = label
            record_type = quality_text(element, "valueRecordType", path, 1000, "RecordType")
            if record_type is not None:
                value["recordType"] = record_type
        return value

    def quality_measure(element: ET.Element, path: str) -> dict[str, Any] | None:
        prop = context_property(element, f"{mdq}measure", f"{path}.measure")
        node = context_embedded(prop, f"{mdq}DQ_MeasureReference", f"{path}.measure")
        if node is None:
            return None
        context_unknown(
            node,
            {
                f"{mdq}{name}"
                for name in ("measureIdentification", "nameOfMeasure", "measureDescription")
            },
            f"{path}.measure",
        )
        value: dict[str, Any] = {}
        names: list[str] = []
        for index, name_scope in enumerate(context_properties(node, "nameOfMeasure")):
            name_path = f"{path}.measure.nameOfMeasure[{index}]"
            text_node = (
                context_embedded(name_scope, f"{gco}CharacterString", name_path)
                if name_scope.tag == f"{mdq}nameOfMeasure"
                else None
            )
            raw = text_node.text if text_node is not None and not len(text_node) else None
            if (
                index >= 8
                or raw is None
                or raw != raw.strip()
                or not 1 <= len(raw) <= 300
                or not _iso_quality_unit_label_supported(raw)
            ):
                context_loss(name_path)
            else:
                names.append(raw)
        if names:
            value["names"] = names
        if context_properties(node, "measureIdentification"):
            prop = context_property(
                node, f"{mdq}measureIdentification", f"{path}.measure.identifier"
            )
            identifier = context_embedded(prop, f"{mcc}MD_Identifier", f"{path}.measure.identifier")
            if identifier is not None:
                context_unknown(
                    identifier, {f"{mcc}code", f"{mcc}codeSpace"}, f"{path}.measure.identifier"
                )
                code = context_text(
                    identifier,
                    f"{mcc}code",
                    f"{gco}CharacterString",
                    f"{path}.measure.identifier.code",
                    300,
                )
                code_space = context_text(
                    identifier,
                    f"{mcc}codeSpace",
                    f"{gco}CharacterString",
                    f"{path}.measure.identifier.codeSpace",
                    300,
                )
                if code is not None:
                    value["identifier"] = {
                        "code": code,
                        **({"codeSpace": code_space} if code_space is not None else {}),
                    }
                else:
                    context_loss(f"{path}.measure.identifier")
        description = quality_text(node, "measureDescription", f"{path}.measure")
        if description is not None:
            value["description"] = description
        if not names and "identifier" not in value:
            context_loss(f"{path}.measure[missing-name-or-code]")
            return None
        return value

    def quality_evaluation(element: ET.Element, path: str) -> dict[str, Any] | None:
        prop = context_property(element, f"{mdq}evaluationMethod", f"{path}.evaluation")
        if (
            prop is None
            or prop.attrib
            or (prop.text or "").strip()
            or len(prop) != 1
            or (prop[0].tail or "").strip()
        ):
            context_loss(f"{path}.evaluation")
            return None
        node = prop[0]
        kind = _local_name(node.tag)
        if node.tag != f"{mdq}{kind}" or kind not in ISO_QUALITY_EVALUATION_TYPES or node.attrib:
            context_loss(f"{path}.evaluation")
            return None
        allowed = {
            "dateTime",
            "evaluationMethodDescription",
            "evaluationProcedure",
            "referenceDoc",
            "evaluationMethodType",
        }
        if kind == "DQ_IndirectEvaluation":
            allowed.add("deductiveSource")
        if kind == "DQ_SampleBasedInspection":
            allowed.update({"samplingScheme", "lotDescription", "samplingRatio"})
        context_unknown(node, {f"{mdq}{name}" for name in allowed}, f"{path}.evaluation")
        value: dict[str, Any] = {"type": kind}
        description = quality_text(node, "evaluationMethodDescription", f"{path}.evaluation")
        if description is not None:
            value["description"] = description
        method_type = quality_code(
            node, mdq, "evaluationMethodType", "DQ_EvaluationMethodTypeCode", f"{path}.evaluation"
        )
        if method_type in {"directInternal", "directExternal", "indirect"}:
            value["methodType"] = method_type
        elif method_type is not None:
            context_loss(f"{path}.evaluation.methodType")
        if context_properties(node, "evaluationProcedure"):
            citation = quality_citation(node, "evaluationProcedure", f"{path}.evaluation")
            if citation is not None:
                value["procedure"] = citation
        dates: list[str] = []
        for index, date_scope in enumerate(context_properties(node, "dateTime")):
            date_path = f"{path}.evaluation.dateTime[{index}]"
            stamp_node = (
                context_embedded(date_scope, f"{gco}DateTime", date_path)
                if date_scope.tag == f"{mdq}dateTime"
                else None
            )
            stamp = context_datetime(
                stamp_node.text if stamp_node is not None and not len(stamp_node) else None,
                date_path,
            )
            if index >= 8 or stamp is None:
                context_loss(date_path)
            else:
                dates.append(stamp)
        if dates:
            value["dateTimes"] = dates
        references: list[dict[str, Any]] = []
        for index, ref_scope in enumerate(context_properties(node, "referenceDoc")):
            ref_path = f"{path}.evaluation.referenceDoc[{index}]"
            # The shared citation reader expects a property owner; preserve this exact wrapper.
            owner = ET.Element("citation-owner")
            owner.append(ref_scope)
            citation = quality_citation(owner, "referenceDoc", ref_path)
            if index >= 8 or citation is None:
                context_loss(ref_path)
            else:
                references.append(citation)
        if references:
            value["referenceDocuments"] = references
        if kind == "DQ_IndirectEvaluation":
            sources: list[str] = []
            for index, source_scope in enumerate(context_properties(node, "deductiveSource")):
                owner = ET.Element("source-owner")
                owner.append(source_scope)
                source = quality_text(
                    owner, "deductiveSource", f"{path}.evaluation.deductiveSource[{index}]"
                )
                if index >= 8 or source is None:
                    context_loss(f"{path}.evaluation.deductiveSource[{index}]")
                else:
                    sources.append(source)
            if not sources:
                context_loss(f"{path}.evaluation.deductiveSource")
                return None
            value["deductiveSources"] = sources
        if kind == "DQ_SampleBasedInspection":
            for name in ("samplingScheme", "lotDescription", "samplingRatio"):
                raw = quality_text(node, name, f"{path}.evaluation")
                if raw is None:
                    context_loss(f"{path}.evaluation.{name}")
                    return None
                value[name] = raw
        return value

    for group_index, quality_scope_wrapper in enumerate(
        context_properties(root, "dataQualityInfo")
    ):
        path = f"mdb:dataQualityInfo[{group_index}]"
        quality_node = (
            context_embedded(quality_scope_wrapper, f"{mdq}DQ_DataQuality", path)
            if quality_scope_wrapper.tag == f"{mdb}dataQualityInfo"
            else None
        )
        if quality_node is None or len(quality_groups) >= 8:
            context_loss(path)
            continue
        context_unknown(quality_node, {f"{mdq}scope", f"{mdq}report"}, path)
        scope = quality_scope(quality_node, "scope", path)
        if scope is None:
            context_loss(f"{path}.scope")
            continue
        reports: list[dict[str, Any]] = []
        for report_index, report_scope in enumerate(context_properties(quality_node, "report")):
            report_path = f"{path}.report[{report_index}]"
            if (
                report_scope.tag != f"{mdq}report"
                or report_scope.attrib
                or (report_scope.text or "").strip()
                or len(report_scope) != 1
                or (report_scope[0].tail or "").strip()
            ):
                context_loss(report_path)
                continue
            report_node = report_scope[0]
            kind = _local_name(report_node.tag)
            if (
                report_node.tag != f"{mdq}{kind}"
                or kind not in ISO_QUALITY_REPORT_TYPES
                or set(report_node.attrib) - {"id"}
                or len(reports) + sum(len(group["reports"]) for group in quality_groups) >= 32
            ):
                context_loss(report_path)
                continue
            raw_id = report_node.get("id")
            if raw_id is not None and (
                len(xml_id_nodes.get(raw_id, [])) != 1
                or raw_id != raw_id.strip()
                or not 1 <= len(raw_id) <= 100
            ):
                context_loss(f"{report_path}.id[ambiguous-or-invalid]")
                continue
            if raw_id is not None:
                try:
                    _quality_id(raw_id, f"{report_path}.id")
                except CatalogMetadataInvalid:
                    context_loss(f"{report_path}.id[invalid]")
                    continue
            context_unknown(
                report_node,
                {
                    f"{mdq}{name}"
                    for name in (
                        "standaloneQualityReportDetails",
                        "measure",
                        "evaluationMethod",
                        "result",
                        "derivedElement",
                        "relatedElement",
                    )
                },
                report_path,
            )
            typed: dict[str, Any] = {"type": kind}
            if raw_id is not None:
                typed["id"] = raw_id
            details = quality_text(report_node, "standaloneQualityReportDetails", report_path)
            if details is not None:
                typed["standaloneDetails"] = details
            if context_properties(report_node, "measure"):
                measure_value = quality_measure(report_node, report_path)
                if measure_value is not None:
                    typed["measure"] = measure_value
            if context_properties(report_node, "evaluationMethod"):
                evaluation = quality_evaluation(report_node, report_path)
                if evaluation is not None:
                    typed["evaluation"] = evaluation
            results: list[dict[str, Any]] = []
            for result_index, prop in enumerate(context_properties(report_node, "result")):
                result_path = f"{report_path}.result[{result_index}]"
                if (
                    result_index >= 8
                    or prop.tag != f"{mdq}result"
                    or prop.attrib
                    or (prop.text or "").strip()
                    or len(prop) != 1
                    or (prop[0].tail or "").strip()
                    or prop[0].attrib
                ):
                    context_loss(result_path)
                    continue
                result = quality_result(prop[0], result_path, report_node)
                if result is not None:
                    results.append(result)
            if not results:
                context_loss(f"{report_path}.result[missing-supported-result]")
                continue
            typed["results"] = results
            for name, target in (
                ("derivedElement", "derivedReports"),
                ("relatedElement", "relatedReports"),
            ):
                for ref_index, prop in enumerate(context_properties(report_node, name)):
                    ref_path = f"{report_path}.{name}[{ref_index}]"
                    href = prop.get(href_attribute)
                    if (
                        ref_index >= 8
                        or prop.tag != f"{mdq}{name}"
                        or set(prop.attrib) != {href_attribute}
                        or len(prop)
                        or (prop.text or "").strip()
                        or not href
                        or not href.startswith("#")
                        or (
                            name == "relatedElement"
                            and kind
                            not in {"DQ_Confidence", "DQ_Homogeneity", "DQ_Representativity"}
                        )
                    ):
                        context_loss(ref_path)
                    else:
                        quality_refs.append((typed, target, href[1:], ref_path))
            reports.append(typed)
            quality_report_nodes[id(typed)] = report_node
        if reports:
            quality_groups.append({"scope": scope, "reports": reports})

    accepted_ids = {
        report["id"] for group in quality_groups for report in group["reports"] if "id" in report
    }
    for report, field, identifier, path in quality_refs:
        if identifier not in accepted_ids:
            context_loss(f"{path}[dangling-or-ambiguous]")
        else:
            values = report.setdefault(field, [])
            values.append(identifier)

    # Only the exact old scalar profile projects to legacy quality, without duplication.
    rich_groups: list[dict[str, Any]] = []
    expected_level = (
        "service"
        if any(_local_name(node.tag) == "SV_ServiceIdentification" for node in root.iter())
        else "dataset"
    )
    for group in quality_groups:
        legacy: list[dict[str, Any]] = []
        legacy_unit_maps: list[str] = []
        legacy_unit_losses: list[str] = []
        if group["scope"]["level"] == expected_level:
            for report in group["reports"]:
                measure = report.get("measure", {})
                results = report["results"]
                if (
                    set(report) - {"type", "measure", "results"}
                    or report["type"] != "DQ_UsabilityElement"
                    or set(measure) - {"names", "description"}
                    or len(measure.get("names", [])) != 1
                    or len(results) != 1
                ):
                    break
                result = results[0]
                if result["type"] == "DQ_DescriptiveResult" and set(result) == {
                    "type",
                    "statement",
                }:
                    scalar: Any = result["statement"]
                elif (
                    result["type"] == "DQ_QuantitativeResult"
                    and set(result) <= {"type", "values", "unit"}
                    and len(result["values"]) == 1
                ):
                    raw = result["values"][0]
                    scalar = _iso_quality_scalar(raw)
                    rendered = str(scalar).lower() if isinstance(scalar, bool) else str(scalar)
                    if scalar is None or isinstance(scalar, str) or rendered != raw:
                        break
                    if "unit" in result and isinstance(scalar, bool):
                        break
                else:
                    break
                entry: dict[str, Any] = {"measure": measure["names"][0], "result": scalar}
                if "description" in measure:
                    entry["description"] = measure["description"]
                legacy_index = len(quality) + len(legacy)
                if "unit" in result:
                    entry["unit"] = result["unit"]
                    legacy_unit_maps.append(
                        f"mdq:valueUnit->metadata_extensions.opengeo.quality[{legacy_index}].unit"
                    )
                else:
                    source_quantitative = quality_report_nodes[id(report)].find(
                        f"{mdq}result/{mdq}DQ_QuantitativeResult"
                    )
                    if source_quantitative is not None and context_properties(
                        source_quantitative, "valueUnit"
                    ):
                        legacy_unit_losses.append(
                            f"dataQualityInfo.quality[{legacy_index}].valueUnit[unsupported]"
                        )
                legacy.append(entry)
        if len(legacy) == len(group["reports"]):
            quality.extend(legacy)
            quality_unit_mapped.extend(legacy_unit_maps)
            quality_unit_unmapped.extend(legacy_unit_losses)
        else:
            rich_groups.append(group)
    quality_groups = rich_groups

    catalog: dict[str, Any] = {"schemaVersion": "1.0.0"}
    mapped: list[str] = []
    for catalog_value, target, source in (
        (contacts, "contacts", "mdb:contact"),
        (reference_systems, "referenceSystems", "mdb:referenceSystemInfo"),
        (distributions, "distributions", "mdb:distributionInfo"),
        (quality, "quality", "mdb:dataQualityInfo"),
        (quality_groups, "qualityReports", "mdb:dataQualityInfo"),
        (lineage, "lineage", "mdb:resourceLineage"),
        (acquisition, "acquisition", "mdb:acquisitionInformation"),
    ):
        if catalog_value:
            catalog[target] = catalog_value
            mapped.append(f"{source}->metadata_extensions.opengeo.{target}")
    if acquisition:
        if acquisition_context_mapped:
            catalog["schemaVersion"] = "1.4.0"
        elif platform_passes or events:
            catalog["schemaVersion"] = "1.3.0"
        elif plans or objectives or requirements:
            catalog["schemaVersion"] = "1.2.0"
        else:
            catalog["schemaVersion"] = "1.1.0"
    for owner, key, entries in reversed(acquisition_context_blocks):
        if len(canonical_json_bytes({"opengeo": catalog})) <= 8_192:
            break
        if key not in owner:
            continue
        del owner[key]
        dropped = {f"{source}->{target}" for source, target in entries}
        acquisition_context_mapped[:] = [
            entry for entry in acquisition_context_mapped if entry not in dropped
        ]
        acquisition_unmapped.extend(f"{source}[size-limit]" for source, _ in entries)
        if not acquisition:
            catalog.pop("acquisition", None)
            mapped.remove("mdb:acquisitionInformation->metadata_extensions.opengeo.acquisition")
            catalog["schemaVersion"] = "1.0.0"
        elif not any(
            block_key in block_owner for block_owner, block_key, _ in acquisition_context_blocks
        ):
            catalog["schemaVersion"] = (
                "1.3.0"
                if platform_passes or events
                else "1.2.0"
                if plans or objectives or requirements
                else "1.1.0"
            )
    for index in reversed(range(len(distributions))):
        if len(canonical_json_bytes({"opengeo": catalog})) <= 8_192:
            break
        if "isoTransfer" in distributions[index]:
            if not any(key in distributions[index] for key in ("accessUrl", "downloadUrl")):
                distributions.pop(index)
                distribution_unmapped.append(
                    f"mdb:distributionInfo->distributions[{index}][size-limit]"
                )
            else:
                del distributions[index]["isoTransfer"]
                distribution_unmapped.append(
                    f"mdb:distributionInfo->distributions[{index}].isoTransfer[size-limit]"
                )
    if any("isoTransfer" in value for value in distributions):
        catalog["schemaVersion"] = "1.5.0"
    while quality_groups and len(canonical_json_bytes({"opengeo": catalog})) > 8_192:
        quality_unit_unmapped.append(
            f"mdb:dataQualityInfo->qualityReports[{len(quality_groups) - 1}][size-limit]"
        )
        quality_groups.pop()
    if not quality_groups and "qualityReports" in catalog:
        del catalog["qualityReports"]
        mapped.remove("mdb:dataQualityInfo->metadata_extensions.opengeo.qualityReports")
    surviving_ids = {
        report["id"] for group in quality_groups for report in group["reports"] if "id" in report
    }
    for group_index, group in enumerate(quality_groups):
        for report_index, report in enumerate(group["reports"]):
            for field in ("derivedReports", "relatedReports"):
                if field in report:
                    retained_ids = []
                    for ref_index, identifier in enumerate(report[field]):
                        if identifier in surviving_ids:
                            retained_ids.append(identifier)
                        else:
                            quality_unit_unmapped.append(
                                f"metadata_extensions.opengeo.qualityReports[{group_index}].reports[{report_index}].{field}[{ref_index}][size-limit-target]"
                            )
                    if retained_ids:
                        report[field] = retained_ids
                    else:
                        del report[field]
    if quality_groups:
        catalog["schemaVersion"] = "1.6.0"
    if any(value.get("isoTransfer", {}).get("offlineMedia") for value in distributions):
        catalog["schemaVersion"] = "1.7.0"
    if not distributions and "distributions" in catalog:
        del catalog["distributions"]
        mapped.remove("mdb:distributionInfo->metadata_extensions.opengeo.distributions")
    unmapped = distribution_unmapped
    mapped.extend(quality_unit_mapped)
    mapped.extend(acquisition_context_mapped)
    if inverse_plan_mapped:
        mapped.append(
            "mac:satisifiedPlan->metadata_extensions.opengeo.acquisition.plans.requirementIdentifiers"
        )
    unmapped.extend(quality_unit_unmapped)
    unmapped.extend(acquisition_unmapped)
    if len(lineage_scopes) > 1:
        unmapped.append("resourceLineage[1:]")
    return (catalog if len(catalog) > 1 else None), mapped, unmapped


def _iso_quality_unit(
    root: ET.Element,
    quality_element: ET.Element,
    quantitative: ET.Element | None,
    unit_scopes: list[ET.Element],
    *,
    allow_multiple: bool = False,
) -> str | None:
    """Read only an unreferenced simple unit label, without assigning a unit system."""
    mdq = "{http://standards.iso.org/iso/19157/-2/mdq/1.0}"
    gml = "{http://www.opengis.net/gml/3.2}"
    if (
        quantitative is None
        or quantitative.tag != f"{mdq}DQ_QuantitativeResult"
        or (
            not allow_multiple
            and quality_element.findall(f"{mdq}result/{mdq}DQ_QuantitativeResult") != [quantitative]
        )
        or quantitative not in quality_element.findall(f"{mdq}result/{mdq}DQ_QuantitativeResult")
        or len(unit_scopes) != 1
        or quantitative.findall(f"{mdq}valueUnit") != unit_scopes
    ):
        return None
    unit_scope = unit_scopes[0]
    if unit_scope.attrib or (unit_scope.text or "").strip() or len(unit_scope) != 1:
        return None
    definition = unit_scope[0]
    identifier_id = definition.get(f"{gml}id")
    if (
        definition.tag != f"{gml}UnitDefinition"
        or set(definition.attrib) != {f"{gml}id"}
        or identifier_id is None
        or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", identifier_id) is None
        or sum(node.get(f"{gml}id") == identifier_id for node in root.iter()) != 1
        or (definition.text or "").strip()
        or len(definition) != 1
    ):
        return None
    identifier = definition[0]
    label = identifier.text
    if (
        identifier.tag != f"{gml}identifier"
        or identifier.attrib != {"codeSpace": ""}
        or len(identifier)
        or label is None
        or not 1 <= len(label) <= 1_000
        or label != label.strip()
        or not label
        or not _iso_quality_unit_label_supported(label)
        or (identifier.tail or "").strip()
        or (definition.tail or "").strip()
    ):
        return None
    return label


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
