import asyncio
import hashlib
import json
from typing import Any
from urllib.parse import parse_qsl

import pytest

from opengeo_api.source_archiver import (
    AnonymousSourceFetcher,
    FetchedArchive,
    SourceArchiveFailure,
)
from opengeo_api.source_discovery import (
    SourceDiscoveryEngine,
    SourceDiscoveryFailure,
    SourceDiscoverySpec,
    parse_arcgis_catalog,
    parse_arcgis_collection,
    parse_wfs_catalog,
    parse_wfs_collection,
)

SERVICE = "https://services.example.com/arcgis/rest/services/facilities/FeatureServer"
WFS = "https://maps.example.com/geoserver/wfs"


def encoded(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


def arcgis_layer(**changes: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "type": "Feature Layer",
        "name": "Facilities",
        "objectIdField": "OBJECTID",
        "geometryType": "esriGeometryPoint",
        "maxRecordCount": 5_000,
        "advancedQueryCapabilities": {
            "supportsPagination": True,
            "supportsOrderBy": True,
        },
        "fields": [
            {"name": "OBJECTID", "type": "esriFieldTypeOID"},
            {"name": "name", "type": "esriFieldTypeString"},
        ],
    }
    value.update(changes)
    return value


WFS_CAPABILITIES = b"""<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0"
  xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>public:facilities</wfs:Name>
      <wfs:Title>Public facilities</wfs:Title>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>-71.5 42</ows:LowerCorner>
        <ows:UpperCorner>-71 42.5</ows:UpperCorner>
      </ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>
"""

WFS_SCHEMA = b"""<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:public="https://example.com/public"
  targetNamespace="https://example.com/public">
  <xsd:element name="facilities" type="public:facilitiesType"/>
  <xsd:complexType name="facilitiesType">
    <xsd:complexContent>
      <xsd:extension base="gml:AbstractFeatureType">
        <xsd:sequence>
          <xsd:element name="facility_id" type="xsd:integer"/>
          <xsd:element name="name" type="xsd:string"/>
          <xsd:element name="geom" type="gml:PointPropertyType"/>
        </xsd:sequence>
      </xsd:extension>
    </xsd:complexContent>
  </xsd:complexType>
</xsd:schema>
"""


class DocumentFetcher:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.calls: list[dict[str, Any]] = []

    async def fetch_document(self, url: str, **options: Any) -> bytes:
        self.calls.append({"url": url, **options})
        return self.body


class Resolver:
    def __init__(self, addresses: tuple[str, ...]) -> None:
        self.addresses = addresses
        self.calls: list[tuple[str, int]] = []

    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        self.calls.append((host, port))
        return self.addresses


class MetadataTransport:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.calls: list[dict[str, Any]] = []

    async def fetch(self, target, pinned_address, request, destination):
        self.calls.append(
            {
                "host": target.host,
                "path": target.path_and_query,
                "address": pinned_address,
                "accept": request.accept,
                "accepted": request.accepted_media_types,
                "maximum": request.maximum_bytes,
            }
        )
        destination.write_bytes(self.body)
        return FetchedArchive(
            "application/geo+json",
            len(self.body),
            hashlib.sha256(self.body).hexdigest(),
        )


def test_arcgis_catalog_returns_only_bounded_feature_layers() -> None:
    result = parse_arcgis_catalog(
        SERVICE,
        encoded(
            {
                "layers": [
                    {
                        "id": 0,
                        "name": "Facilities",
                        "type": "Feature Layer",
                        "geometryType": "esriGeometryPoint",
                    },
                    {"id": 1, "name": "Group", "type": "Group Layer"},
                    {
                        "id": 2,
                        "name": "Areas",
                        "type": "Feature Layer",
                        "geometryType": "esriGeometryPolygon",
                    },
                ]
            }
        ),
    )

    assert result.json_value() == {
        "schema_version": "opengeo.external-source-discovery-result.1.0.0",
        "source_type": "arcgis",
        "kind": "catalog",
        "service_url": SERVICE,
        "collections": [
            {
                "ref": "0",
                "name": "Facilities",
                "title": "Facilities",
                "geometry_type": "Point",
                "bounds": None,
            },
            {
                "ref": "2",
                "name": "Areas",
                "title": "Areas",
                "geometry_type": "MultiPolygon",
                "bounds": None,
            },
        ],
        "source_definition": None,
        "limitations": ["Select one layer to inspect its fields and stable identity."],
    }


def test_arcgis_collection_prefills_only_verified_identity_and_pagination() -> None:
    result = parse_arcgis_collection(SERVICE, "0", encoded(arcgis_layer()))

    assert result.source_definition == {
        "type": "arcgis",
        "url": f"{SERVICE}/0",
        "object_id_field": "OBJECTID",
        "fields": ["OBJECTID", "name"],
        "available_fields": ["OBJECTID", "name"],
        "geometry_type": "Point",
        "page_size": 2_000,
        "attribution": None,
        "requires_field_selection": False,
        "excluded_field_count": 0,
    }


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"advancedQueryCapabilities": {}}, "discovery_collection_unsupported"),
        (
            {"fields": [{"name": "OBJECTID", "type": "esriFieldTypeInteger"}]},
            "discovery_identity_unsupported",
        ),
        ({"geometryType": "esriGeometryEnvelope"}, "discovery_geometry_unsupported"),
        (
            {"fields": [{"name": "OBJECTID", "type": "esriFieldTypeOID"}] * 257},
            "discovery_response_too_large",
        ),
    ],
)
def test_arcgis_collection_rejects_unstable_or_unbounded_contracts(
    changes: dict[str, Any], code: str
) -> None:
    with pytest.raises(SourceDiscoveryFailure) as error:
        parse_arcgis_collection(SERVICE, "0", encoded(arcgis_layer(**changes)))
    assert error.value.code == code


def test_arcgis_catalog_rejects_duplicate_members_and_overlarge_catalogs() -> None:
    with pytest.raises(SourceDiscoveryFailure) as error:
        parse_arcgis_catalog(SERVICE, b'{"layers":[],"layers":[]}')
    assert error.value.code == "discovery_response_invalid"

    layers = [
        {"id": value, "name": f"Layer {value}", "type": "Feature Layer"} for value in range(101)
    ]
    with pytest.raises(SourceDiscoveryFailure) as error:
        parse_arcgis_catalog(SERVICE, encoded({"layers": layers}))
    assert error.value.code == "discovery_response_too_large"


def test_wfs_catalog_reads_exact_20_capabilities_and_bounds() -> None:
    result = parse_wfs_catalog(WFS, WFS_CAPABILITIES)

    assert result.collections == (
        {
            "ref": "public:facilities",
            "name": "public:facilities",
            "title": "Public facilities",
            "geometry_type": None,
            "bounds": [-71.5, 42.0, -71.0, 42.5],
        },
    )


def test_wfs_collection_prefills_reviewable_schema_and_requires_sort_confirmation() -> None:
    result = parse_wfs_collection(WFS, "public:facilities", WFS_SCHEMA)

    assert result.source_definition == {
        "type": "wfs",
        "url": WFS,
        "version": "2.0.0",
        "type_name": "public:facilities",
        "geometry_name": "geom",
        "fields": ["facility_id", "name"],
        "available_fields": ["facility_id", "name"],
        "sort_by": "facility_id",
        "geometry_type": "Point",
        "page_size": 1_000,
        "attribution": None,
        "requires_field_selection": False,
        "requires_sort_confirmation": True,
        "excluded_field_count": 0,
    }


def test_wfs_collection_supports_inline_complex_type() -> None:
    inline = WFS_SCHEMA.replace(
        b'<xsd:element name="facilities" type="public:facilitiesType"/>',
        b'<xsd:element name="facilities"><xsd:complexType><xsd:sequence>'
        b'<xsd:element name="facility_id" type="xsd:integer"/>'
        b'<xsd:element name="geom" type="gml:PointPropertyType"/>'
        b"</xsd:sequence></xsd:complexType></xsd:element>",
    )
    result = parse_wfs_collection(WFS, "public:facilities", inline)
    assert result.source_definition is not None
    assert result.source_definition["fields"] == ["facility_id"]


@pytest.mark.parametrize(
    "body,code",
    [
        (
            b'<!DOCTYPE schema [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><schema/>',
            "discovery_response_invalid",
        ),
        (
            b'<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>',
            "discovery_upstream_rejected",
        ),
        (b"<schema>", "discovery_response_invalid"),
    ],
)
def test_wfs_rejects_active_or_malformed_xml(body: bytes, code: str) -> None:
    parser = (
        parse_wfs_catalog
        if b"DOCTYPE" not in body and b"Exception" in body
        else parse_wfs_collection
    )
    with pytest.raises(SourceDiscoveryFailure) as error:
        if parser is parse_wfs_catalog:
            parser(WFS, body)
        else:
            parser(WFS, "public:facilities", body)
    assert error.value.code == code


def test_engine_builds_only_canonical_catalog_and_collection_requests() -> None:
    arcgis_fetcher = DocumentFetcher(
        encoded({"layers": [{"id": 0, "name": "Facilities", "type": "Feature Layer"}]})
    )
    arcgis = SourceDiscoveryEngine(arcgis_fetcher)
    asyncio.run(arcgis.discover(SourceDiscoverySpec("arcgis", "catalog", SERVICE)))
    assert arcgis_fetcher.calls == [
        {
            "url": SERVICE,
            "parameters": [("f", "json")],
            "accept": "application/json",
            "accepted_media_types": frozenset({"application/json"}),
            "maximum_bytes": 2_097_152,
        }
    ]

    wfs_fetcher = DocumentFetcher(WFS_SCHEMA)
    wfs = SourceDiscoveryEngine(wfs_fetcher)
    asyncio.run(wfs.discover(SourceDiscoverySpec("wfs", "collection", WFS, "public:facilities")))
    assert wfs_fetcher.calls[0]["parameters"] == [
        ("SERVICE", "WFS"),
        ("VERSION", "2.0.0"),
        ("REQUEST", "DescribeFeatureType"),
        ("TYPENAMES", "public:facilities"),
    ]


@pytest.mark.parametrize(
    "spec",
    [
        ("arcgis", "catalog", "http://services.example.com/FeatureServer", None),
        ("arcgis", "catalog", f"{SERVICE}/0", None),
        ("arcgis", "catalog", f"{SERVICE}?f=json", None),
        ("arcgis", "collection", SERVICE, "-1"),
        ("wfs", "catalog", WFS, "public:facilities"),
        ("wfs", "collection", WFS, "public facilities"),
    ],
)
def test_discovery_spec_rejects_ambiguous_or_unsafe_requests(spec: tuple[Any, ...]) -> None:
    with pytest.raises(ValueError):
        SourceDiscoverySpec(*spec)


def test_metadata_fetch_uses_pinned_dns_and_canonical_encoded_query() -> None:
    resolver = Resolver(("93.184.216.34",))
    transport = MetadataTransport(b'{"layers":[]}')
    fetcher = AnonymousSourceFetcher(
        resolver=resolver,
        transport=transport,
        timeout_seconds=15,
    )

    body = asyncio.run(
        fetcher.fetch_document(
            WFS,
            parameters=[("SERVICE", "WFS"), ("TYPENAMES", "public:facilities")],
            accept="application/json",
            accepted_media_types=frozenset({"application/json"}),
            maximum_bytes=2_097_152,
        )
    )

    assert body == b'{"layers":[]}'
    assert resolver.calls == [("maps.example.com", 443)]
    assert transport.calls[0]["address"] == "93.184.216.34"
    path, query = transport.calls[0]["path"].split("?", 1)
    assert path == "/geoserver/wfs"
    assert parse_qsl(query) == [("SERVICE", "WFS"), ("TYPENAMES", "public:facilities")]


@pytest.mark.parametrize(
    "parameters,accept,media",
    [
        ([("bad\r\nheader", "value")], "application/json", frozenset({"application/json"})),
        ([("SERVICE", "bad\nvalue")], "application/json", frozenset({"application/json"})),
        ([("SERVICE", "WFS")], "application/json\r\nX-Test: true", frozenset({"application/json"})),
        ([("SERVICE", "WFS")], "application/json", frozenset({"text/html"})),
    ],
)
def test_metadata_fetch_rejects_request_injection_or_media_expansion(
    parameters: list[tuple[str, str]], accept: str, media: frozenset[str]
) -> None:
    fetcher = AnonymousSourceFetcher(
        resolver=Resolver(("93.184.216.34",)),
        transport=MetadataTransport(b"{}"),
        timeout_seconds=15,
    )
    with pytest.raises(SourceArchiveFailure) as error:
        asyncio.run(
            fetcher.fetch_document(
                WFS,
                parameters=parameters,
                accept=accept,
                accepted_media_types=media,
                maximum_bytes=2_097_152,
            )
        )
    assert error.value.code == "source_contract_invalid"
    assert error.value.retryable is False


def test_engine_redacts_archive_transport_failure_to_stable_discovery_code() -> None:
    class FailingFetcher:
        async def fetch_document(self, *args: Any, **kwargs: Any) -> bytes:
            del args, kwargs
            raise SourceArchiveFailure("unsafe_network_target", retryable=False)

    with pytest.raises(SourceDiscoveryFailure) as error:
        asyncio.run(
            SourceDiscoveryEngine(FailingFetcher()).discover(
                SourceDiscoverySpec("arcgis", "catalog", SERVICE)
            )
        )
    assert error.value.code == "unsafe_network_target"
    assert error.value.retryable is False


def test_discovery_preserves_response_bytes_without_a_second_fetch_or_result_change():
    import base64

    body = b" \n" + json.dumps(arcgis_layer(), indent=2).encode() + b"\r\n"
    fetcher = DocumentFetcher(body)
    result = asyncio.run(
        SourceDiscoveryEngine(fetcher).discover(
            SourceDiscoverySpec("arcgis", "collection", SERVICE, "0")
        )
    )
    assert len(fetcher.calls) == 1
    assert result.source_document is not None
    assert base64.b64decode(result.source_document["body_base64"]) == body
    assert result.source_document["sha256"] == hashlib.sha256(body).hexdigest()
    assert result.source_document["byte_length"] == len(body)
    assert "source_document" not in result.json_value()
    assert "body_base64" not in repr(result)

    large_body = encoded(arcgis_layer(description="x" * 40_000))
    large = asyncio.run(
        SourceDiscoveryEngine(DocumentFetcher(large_body)).discover(
            SourceDiscoverySpec("arcgis", "collection", SERVICE, "0")
        )
    )
    assert large.source_document["status"] == "not_retained_size"
    assert large.source_document["body_base64"] is None
    assert large.source_document["sha256"] == hashlib.sha256(large_body).hexdigest()
