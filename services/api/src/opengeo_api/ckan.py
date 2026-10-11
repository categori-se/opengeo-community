"""Bounded CKAN Action API v3 reads and loss-aware DCAT 3 metadata registration.

CKAN is a source protocol, not a new OpenGeo resource model. No data bytes,
credentials, upstream permissions or publication flags are imported here.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from contextlib import suppress
from dataclasses import replace
from hashlib import sha256
from typing import Any, Protocol
from urllib.parse import quote, urlsplit, urlunsplit

from opengeo_api.metadata_adapters import (
    MetadataImportInvalid,
    assert_safe_metadata_source,
    build_metadata_import_plan,
    metadata_source_checksum,
)
from opengeo_api.resources import MetadataResourceImportPlan
from opengeo_api.source_archiver import AnonymousSourceFetcher, SourceArchiveFailure

ADAPTER_VERSION = "1.0.0"
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
_MEDIA = frozenset({"application/json"})


class CkanFailure(ValueError):
    """A public error code; never include an upstream body or URL in an error."""


class CkanFetcher(Protocol):
    async def fetch_document(
        self,
        url: str,
        *,
        parameters: list[tuple[str, str]],
        accept: str,
        accepted_media_types: frozenset[str],
        maximum_bytes: int,
    ) -> bytes: ...


def canonical_ckan_url(value: str) -> str:
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        port = url.port
        address = None
        with suppress(ValueError):
            address = ipaddress.ip_address(host)
        if (
            url.scheme != "https"
            or not host
            or url.username
            or url.password
            or port not in {None, 443}
            or url.query
            or url.fragment
            or len(value) > 2_048
            or any(ord(c) < 33 or ord(c) > 126 for c in value)
            or "\\" in value
            or "%" in url.path
            or any(part in {".", ".."} for part in url.path.split("/"))
            or host.endswith((".localhost", ".local", ".internal"))
            or host == "localhost"
            or (address is not None and not address.is_global)
        ):
            raise CkanFailure("ckan_url_invalid")
        return urlunsplit(
            ("https", url.netloc.lower().removesuffix(":443"), url.path.rstrip("/"), "", "")
        )
    except (ValueError, UnicodeError) as error:
        raise CkanFailure("ckan_url_invalid") from error


def ckan_identifier(value: Any) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise CkanFailure("ckan_identifier_invalid")
    return value


def _text(value: Any, maximum: int, *, required: bool = False) -> str | None:
    if value is None or value == "":
        if required:
            raise CkanFailure("ckan_metadata_invalid")
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise CkanFailure("ckan_metadata_invalid")
    return value


def _public_package(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CkanFailure("ckan_metadata_invalid")
    if value.get("private") is not False or value.get("state") != "active":
        raise CkanFailure("ckan_dataset_not_public_active")
    ckan_identifier(value.get("id"))
    ckan_identifier(value.get("name"))
    _text(value.get("title") or value.get("name"), 300, required=True)
    try:
        assert_safe_metadata_source(value)
    except MetadataImportInvalid as error:
        raise CkanFailure("ckan_metadata_unsafe_or_too_large") from error
    return value


def ckan_package_to_dcat(source_url: str, package: dict[str, Any]) -> dict[str, Any]:
    """Preserve the complete source package beside an explicit DCAT crosswalk."""
    source_url = canonical_ckan_url(source_url)
    package = _public_package(package)
    identifier = package["id"]
    scope = sha256(source_url.encode()).hexdigest()
    document: dict[str, Any] = {
        "@context": {
            "dcat": "http://www.w3.org/ns/dcat#",
            "dct": "http://purl.org/dc/terms/",
            "foaf": "http://xmlns.com/foaf/0.1/",
            "ckan": "https://opengeo.tools/ns/ckan#",
        },
        "@id": f"{source_url}/dataset/{quote(package['name'], safe='')}",
        "@type": "dcat:Dataset",
        "dct:identifier": f"ckan:{scope}:{identifier}",
        "dct:title": package.get("title") or package["name"],
        "ckan:source": {
            "url": source_url,
            "actionApiVersion": "3",
            "adapterVersion": ADAPTER_VERSION,
            "packageSha256": metadata_source_checksum(package),
            "package": package,
        },
    }
    for source, target, maximum in (
        ("notes", "dct:description", 8_000),
        ("license_url", "dct:license", 1_000),
    ):
        if (value := _text(package.get(source), maximum)) is not None:
            document[target] = value
    tags = package.get("tags", [])
    if not isinstance(tags, list) or len(tags) > 64:
        raise CkanFailure("ckan_metadata_invalid")
    keywords: dict[str, str] = {}
    for tag in tags:
        if not isinstance(tag, dict):
            raise CkanFailure("ckan_metadata_invalid")
        name = _text(tag.get("display_name") or tag.get("name"), 100, required=True)
        assert name is not None
        keywords.setdefault(name.casefold(), name)
    if keywords:
        document["dcat:keyword"] = list(keywords.values())
    organization = package.get("organization")
    if isinstance(organization, dict):
        name = _text(organization.get("title") or organization.get("name"), 300)
        if name:
            document["dct:publisher"] = {"@type": "foaf:Agent", "foaf:name": name}
    author = _text(package.get("author"), 300)
    if author:
        document["dct:creator"] = {"@type": "foaf:Agent", "foaf:name": author}
    resources = package.get("resources", [])
    if not isinstance(resources, list) or len(resources) > 64:
        raise CkanFailure("ckan_metadata_invalid")
    distributions = []
    seen: set[str] = set()
    for resource in resources:
        if not isinstance(resource, dict):
            raise CkanFailure("ckan_metadata_invalid")
        resource_id = ckan_identifier(resource.get("id"))
        if resource_id in seen:
            raise CkanFailure("ckan_duplicate_resource")
        seen.add(resource_id)
        if resource.get("state", "active") != "active":
            continue
        url = _text(resource.get("url"), 2_048)
        if not url:
            continue  # Still retained in ckan:source, never invent a distribution URL.
        distribution: dict[str, Any] = {
            "@type": "dcat:Distribution",
            "dct:identifier": resource_id,
            "dcat:accessURL": url,
        }
        # CKAN url may be a service or landing page; it is not proof of a download.
        for source, target, maximum in (
            ("name", "dct:title", 1_000),
            ("format", "dct:format", 1_000),
            ("mimetype", "dcat:mediaType", 1_000),
            ("license_url", "dct:license", 1_000),
        ):
            if (value := _text(resource.get(source), maximum)) is not None:
                distribution[target] = value
        if type(resource.get("size")) is int and resource["size"] >= 0:
            distribution["dcat:byteSize"] = resource["size"]
        distributions.append(distribution)
    if distributions:
        document["dcat:distribution"] = distributions
    return document


def build_ckan_import_plan(
    source_url: str,
    package: dict[str, Any],
    *,
    observation: str = "submitted_snapshot",
) -> MetadataResourceImportPlan:
    document = ckan_package_to_dcat(source_url, package)
    identity = document["dct:identifier"]
    try:
        plan = build_metadata_import_plan(
            source_format="dcat_3",
            source_namespace="ckan",
            document=document,
            source_sha256=metadata_source_checksum(document),
            slug=f"ckan-{sha256(identity.encode()).hexdigest()}",
            visibility="restricted",
        )
    except MetadataImportInvalid as error:
        raise CkanFailure("ckan_metadata_unsafe_or_too_large") from error
    report = {
        **plan.conversion_report,
        "ckan": {
            "actionApiVersion": "3",
            "adapterVersion": ADAPTER_VERSION,
            "sourceUrl": canonical_ckan_url(source_url),
            "packageId": package["id"],
            "packageSha256": metadata_source_checksum(package),
            "observation": observation,
            "custody": "referenced",
            "conformanceClaimed": False,
            "limits": [
                "Original CKAN JSON is retained under ckan:source.package in the source document.",
                "CKAN organizations and groups do not create local Accounts or Collections.",
                "Upstream permissions and publication flags do not grant local access.",
                "Dataset license is not inherited by distributions; absent terms stay unknown.",
                "Resource URLs are access links, not verified downloads or map-ready layers.",
                "Modification times are not temporal coverage; spatial extras remain unmapped.",
            ],
        },
    }
    return replace(plan, conversion_report=report)


class CkanClient:
    def __init__(self, fetcher: CkanFetcher | None = None) -> None:
        self._fetcher = fetcher or AnonymousSourceFetcher(timeout_seconds=15)

    async def _action(
        self,
        source_url: str,
        action: str,
        parameters: list[tuple[str, str]],
    ) -> dict[str, Any]:
        source_url = canonical_ckan_url(source_url)
        try:
            async with asyncio.timeout(20):
                body = await self._fetcher.fetch_document(
                    f"{source_url}/api/3/action/{action}",
                    parameters=parameters,
                    accept="application/json",
                    accepted_media_types=_MEDIA,
                    maximum_bytes=2_097_152,
                )
            if not 1 <= len(body) <= 2_097_152:
                raise CkanFailure("ckan_response_too_large")
            envelope = json.loads(body)
        except (TimeoutError, SourceArchiveFailure) as error:
            raise CkanFailure("ckan_upstream_unavailable") from error
        except (ValueError, RecursionError, UnicodeError) as error:
            if isinstance(error, CkanFailure):
                raise
            raise CkanFailure("ckan_response_invalid") from error
        if not isinstance(envelope, dict) or envelope.get("success") is not True:
            raise CkanFailure("ckan_action_failed")
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise CkanFailure("ckan_response_invalid")
        return result

    async def search(
        self,
        source_url: str,
        *,
        query: str = "",
        start: int = 0,
        rows: int = 20,
        organization: str | None = None,
    ) -> dict[str, Any]:
        if (
            len(query) > 400
            or any(ord(c) < 32 or ord(c) > 126 for c in query)
            or type(start) is not int
            or not 0 <= start <= 10_000
            or type(rows) is not int
            or not 1 <= rows <= 20
        ):
            raise CkanFailure("ckan_search_invalid")
        parameters = [
            ("q", query or "*:*"),
            ("start", str(start)),
            ("rows", str(rows)),
            ("sort", "id asc"),
            ("include_private", "false"),
        ]
        if organization:
            parameters.append(("fq", f"organization:{ckan_identifier(organization)}"))
        result = await self._action(source_url, "package_search", parameters)
        packages = result.get("results")
        total = result.get("count")
        if (
            type(total) is not int
            or total < 0
            or not isinstance(packages, list)
            or len(packages) > rows
            or (total < start + len(packages) and packages)
            or (not packages and total > start)
        ):
            raise CkanFailure("ckan_response_invalid")
        values = []
        for package in packages:
            # Search exposes summaries only. Exceptional metadata is inspected
            # separately, rather than preventing the rest of a page from loading.
            if not isinstance(package, dict):
                raise CkanFailure("ckan_response_invalid")
            if package.get("private") is not False or package.get("state") != "active":
                raise CkanFailure("ckan_dataset_not_public_active")
            ckan_identifier(package.get("id"))
            ckan_identifier(package.get("name"))
            _text(package.get("title") or package.get("name"), 300, required=True)
            values.append(
                {
                    "id": package["id"],
                    "name": package["name"],
                    "title": package.get("title") or package["name"],
                }
            )
        if len({item["id"] for item in values}) != len(values):
            raise CkanFailure("ckan_response_invalid")
        next_start = start + len(values) if values and start + len(values) < total else None
        return {
            "source_url": canonical_ckan_url(source_url),
            "datasets": values,
            "total": total,
            "start": start,
            "rows": rows,
            "next_start": next_start,
        }

    async def package(self, source_url: str, identifier: str) -> dict[str, Any]:
        identifier = ckan_identifier(identifier)
        result = _public_package(
            await self._action(
                source_url,
                "package_show",
                [("id", identifier)],
            )
        )
        if identifier not in {result["id"], result["name"]}:
            raise CkanFailure("ckan_identity_mismatch")
        return result

    async def preview(self, source_url: str, resource_id: str) -> dict[str, Any]:
        result = await self._action(
            source_url,
            "datastore_search",
            [
                ("resource_id", ckan_identifier(resource_id)),
                ("limit", "20"),
                ("offset", "0"),
            ],
        )
        fields, records = result.get("fields"), result.get("records")
        if (
            result.get("resource_id") != resource_id
            or not isinstance(fields, list)
            or not 1 <= len(fields) <= 64
            or not isinstance(records, list)
            or len(records) > 20
        ):
            raise CkanFailure("ckan_response_invalid")
        names = []
        for field in fields:
            if not isinstance(field, dict):
                raise CkanFailure("ckan_response_invalid")
            names.append(_text(field.get("id"), 100, required=True))
        if len(set(names)) != len(names):
            raise CkanFailure("ckan_response_invalid")
        for row in records:
            if not isinstance(row, dict) or not set(row).issubset(names):
                raise CkanFailure("ckan_response_invalid")
        try:
            assert_safe_metadata_source({"fields": fields, "records": records})
        except MetadataImportInvalid as error:
            raise CkanFailure("ckan_preview_too_large_or_unsafe") from error
        return {
            "resource_id": resource_id,
            "fields": names,
            "records": records,
            "limit": 20,
            "custody": "referenced",
        }
