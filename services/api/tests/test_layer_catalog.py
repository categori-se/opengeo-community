import asyncio
from uuid import UUID

import pytest

from opengeo_api.layer_catalog import catalog_service_reference, search_layer_records
from opengeo_api.tenant_database import TenantContext

URL = "https://services.example.org/arcgis/rest/services/Screening/FeatureServer/0"


def test_service_reference_separates_host_layer_and_rendering_source():
    service = catalog_service_reference(URL, "arcgis-feature", 2)
    assert service == {
        "url": URL[:-2],
        "kind": "FeatureServer",
        "layer_id": "0",
        "layer_url": URL,
        "rendering_source": "provider",
        "source_version": 2,
    }
    assert (
        catalog_service_reference(URL, "geojson-archive", 2)["rendering_source"] == "captured_copy"
    )
    image = catalog_service_reference(
        "https://coast.noaa.gov/arcgis/rest/services/Imagery/CIR/ImageServer",
        "imageserver-raster",
        None,
    )
    assert image["layer_id"] is None and image["kind"] == "ImageServer"


@pytest.mark.parametrize(
    "path,kind,layer_id",
    [
        ("/ImageServer", "ImageServer", None),
        ("/ImageServer/", "ImageServer", None),
        ("/FeatureServer/0", "FeatureServer", "0"),
        ("/MapServer/12/", "MapServer", "12"),
    ],
)
def test_root_service_addresses_keep_provider_identity(path, kind, layer_id):
    reference = catalog_service_reference("https://imagery.example.org" + path, "external", 3)
    assert reference == {
        "url": "https://imagery.example.org/" + kind,
        "kind": kind,
        "layer_id": layer_id,
        "layer_url": "https://imagery.example.org/" + kind + ("/" + layer_id if layer_id else ""),
        "rendering_source": "provider",
        "source_version": 3,
    }


@pytest.mark.parametrize(
    "path", ["/ImageServer/0", "/ImageServer/exportImage", "/OtherImageServer", "/../ImageServer"]
)
def test_root_service_support_does_not_accept_operations_or_traversal(path):
    assert catalog_service_reference("https://imagery.example.org" + path, "external", 1) is None


@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        "https://archive.example.org/data.geojson",
        "s3://bucket/key",
        URL + "?token=private",
        URL + "?f=json",
        URL + "#private",
        URL.replace("https://", "http://"),
        URL.replace("https://", "https://user:secret@"),
        URL.replace("services.example.org", "127.0.0.1"),
        URL.replace("services.example.org", "service.internal"),
        URL.replace("services.example.org", "[::1]"),
        URL.replace("Screening", "../secret"),
        URL.replace("Screening", "%2e%2e/secret"),
        URL.replace("Screening", "\\secret"),
        URL.replace("FeatureServer/0", "ImageServer/1"),
        URL + "/query",
        URL.replace("services.example.org", "services.example.org:8443"),
        URL.replace("Screening", "Sc\x00reening"),
        URL.replace("Screening", 'Screening"'),
        URL.replace("Screening", "Écran"),
    ],
)
def test_unshareable_addresses_are_omitted(url):
    assert catalog_service_reference(url, "external", 1) is None


def test_single_scoped_query_returns_only_sanitized_reference():
    identifier = UUID("10000000-0000-4000-8000-000000000001")
    context = TenantContext(identifier, identifier)
    calls = []

    class Transaction:
        async def fetch_all(self, sql, parameters):
            calls.append((sql, parameters))
            base = [
                identifier,
                "Screening",
                identifier,
                "Project",
                "geojson",
                "public",
                "external",
                "2026-09-12T00:00:00Z",
                identifier,
                2,
                "heat",
                "Heat",
                "Heat indicator",
                "heat",
                {},
                "MultiPolygon",
                "a" * 32,
            ]
            return [
                [*base, URL, "arcgis-feature", 2],
                [*base, URL + "?token=secret", "arcgis-feature", 2],
                [*base, "https://imagery.example.org/ImageServer", "imageserver-raster", 3],
            ]

    class Executor:
        async def run(self, supplied, operation):
            assert supplied == context
            return await operation(Transaction())

    literal_query = r"flood_50%\archive"
    records = asyncio.run(search_layer_records(Executor(), context, limit=51, query=literal_query))
    assert len(calls) == 1
    assert records[0]["service"]["layer_id"] == "0"
    assert records[1]["service"] is None
    assert records[2]["service"]["layer_url"] == "https://imagery.example.org/ImageServer"
    assert records[2]["service"]["kind"] == "ImageServer"
    assert "secret" not in str(records) and "provider_url" not in str(records)
    assert "dataset.can_read_maps" in calls[0][0]
    assert calls[0][1][-2:] == (51, 0)
    assert calls[0][1][-4:-2] == (literal_query, literal_query)
    assert "strpos(lower(concat_ws(" in calls[0][0]
    assert "ILIKE" not in calls[0][0]


def test_wfs_reference_is_explicit_and_does_not_invent_arcgis_layer_identity():
    url = "https://maps.example.com/geoserver/wfs"
    reference = catalog_service_reference(url, "wfs", 2)
    assert reference == {
        "url": url,
        "kind": "WFS",
        "layer_id": None,
        "layer_url": url,
        "rendering_source": "provider",
        "source_version": 2,
    }
    assert catalog_service_reference(url, "external", 2) is None
    for invalid in [
        url + "?token=secret",
        url.replace("https:", "http:"),
        "https://maps.internal/wfs",
        "https://maps.example.com/../wfs",
    ]:
        assert catalog_service_reference(invalid, "wfs", 2) is None


def test_cog_catalog_reference_is_metadata_only_and_rejects_signed_urls():
    from opengeo_api.layer_catalog import catalog_service_reference

    url = "https://imagery.example/scene/visual.tif"
    for kind in ["cog", "cog-raster"]:
        result = catalog_service_reference(url, kind, 3)
        assert result["kind"] == "COG"
        assert result["source_version"] == 3
        assert result["layer_url"] == url
        assert result["rendering_source"] == "provider"
    assert catalog_service_reference(url + "?X-Amz-Signature=secret", "cog", 3) is None
