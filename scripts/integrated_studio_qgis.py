"""Read a synthetic Studio-created collection through the installed QGIS provider.

This is local acceptance only: exact loopback routes, disposable QGIS profile,
synthetic authority, no production credentials or application writes.
"""

import gc
import json
import math
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit


def checked_input(path):
    path = Path(path)
    if path != path.resolve() or path.parent.parent != Path("/tmp"):
        raise ValueError("Expected an owned local Studio input")
    if not re.fullmatch(r"opengeo-integrated-studio-[A-Za-z0-9_-]+", path.parent.name):
        raise ValueError("Expected an owned local Studio directory")
    if (
        path.is_symlink()
        or not path.is_file()
        or path.stat().st_size > 65536
        or path.stat().st_uid != os.getuid()
        or path.stat().st_mode & 0o777 != 0o600
    ):
        raise ValueError("Client input must be an owned 0600 regular file")
    value = json.loads(path.read_text())
    if type(value["denied"]) is not bool:
        raise ValueError("Client mode must be explicit")
    if type(value.get("tiles", False)) is not bool:
        raise ValueError("Tile acceptance must be explicit")
    if type(value.get("maps", False)) is not bool:
        raise ValueError("Map acceptance must be explicit")
    url = urlsplit(value["baseUrl"])
    if (
        url.scheme != "http"
        or url.hostname != "127.0.0.1"
        or not url.port
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("Only the synthetic loopback API is allowed")
    from uuid import UUID

    project = str(UUID(value["projectId"]))
    str(UUID(value["organizationId"]))
    if url.path != f"/api/projects/{project}/services/watershed-pilot/ogc":
        raise ValueError("Unexpected client service target")
    if value["token"] != "synthetic-local-owner" or value["collection"] != "watersheds":
        raise ValueError(
            "Only synthetic client authority and the pilot collection are allowed"
        )
    return value, f"{url.scheme}://{url.netloc}", project


def compare_geometry(actual, expected):
    """QGIS asJson(12) rounds coordinates; topology and structure stay exact."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys()
        return max(
            compare_geometry(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected)
        return max(
            (compare_geometry(a, e) for a, e in zip(actual, expected)), default=0
        )
    if type(expected) in (int, float):
        assert type(actual) in (int, float) and math.isfinite(actual)
        difference = abs(actual - expected)
        assert difference <= 1e-12, (
            "QGIS coordinate exceeds 12-decimal serialization tolerance"
        )
        return difference
    assert actual == expected
    return 0


def main():
    from qgis.core import (
        Qgis,
        QgsApplication,
        QgsDataSourceUri,
        QgsFeatureRequest,
        QgsNetworkAccessManager,
        QgsProviderRegistry,
        QgsRasterLayer,
        QgsRectangle,
        QgsVectorLayer,
    )
    from qgis.PyQt.QtCore import QUrl
    from qgis.PyQt.QtGui import qAlpha, qGreen, qRed

    value, origin, project = checked_input(sys.argv[1])
    profile = Path(os.environ["QGIS_CUSTOM_CONFIG_PATH"])
    if profile != Path(sys.argv[1]).parent / (
        "qgis-denied-profile" if value["denied"] else "qgis-read-profile"
    ):
        raise ValueError("QGIS must use this run's disposable profile")
    app = QgsApplication([], False)
    app.initQgis()
    manager = QgsNetworkAccessManager.instance()
    authenticated = False
    rejected = []

    def prepare(request):
        url = request.url().toString()
        allowed = any(
            url.startswith(origin + prefix)
            for prefix in [f"/api/projects/{project}/", f"/projects/{project}/"]
        )
        if not allowed:
            rejected.append("outside-project-request")
            request.setUrl(QUrl(origin + "/__qgis-denied"))
            return
        request.setRawHeader(b"User-Agent", b"OpenGeo-Integrated-QGIS/1.0")
        if authenticated:
            request.setRawHeader(b"Authorization", b"Bearer synthetic-local-owner")
            request.setRawHeader(
                b"X-OpenGeo-Organization", value["organizationId"].encode()
            )

    hook = manager.setRequestPreprocessor(prepare)
    layer = anonymous = filtered_layer = raster = raster_anonymous = block = None
    features = []
    try:
        assert Qgis.QGIS_VERSION == "3.44.12-Solothurn"
        uri = QgsDataSourceUri()
        uri.setParam("url", value["baseUrl"])
        uri.setParam("typename", value["collection"])
        uri.setParam("pagingEnabled", "true")
        uri.setParam("pageSize", "1")
        uri.setParam("restrictToRequestBBOX", "1")
        anonymous = QgsVectorLayer(
            uri.uri(False), "Anonymous pilot collection", "OAPIF"
        )
        assert not anonymous.isValid(), (
            "Anonymous QGIS discovery unexpectedly succeeded"
        )
        authenticated = True
        layer = QgsVectorLayer(uri.uri(False), "Studio watershed collection", "OAPIF")
        if value["denied"]:
            assert not layer.isValid(), (
                "Withdrawn collection remained discoverable in QGIS"
            )
            result = {
                "version": Qgis.QGIS_VERSION,
                "withdrawnRejected": True,
                "anonymousRejected": True,
            }
        else:
            assert layer.isValid(), layer.error().summary()
            assert layer.crs().isValid() and layer.crs().authid() == "OGC:CRS84", (
                f"Expected the service's longitude/latitude CRS84, got {layer.crs().authid()!r}"
            )
            fields = [field.name() for field in layer.fields()]
            features = list(layer.getFeatures())
            observed = sorted(
                [
                    {
                        "geometry": json.loads(feature.geometry().asJson(12)),
                        "properties": {
                            name: feature[name] for name in ["name", "value"]
                        },
                    }
                    for feature in features
                ],
                key=lambda feature: feature["properties"]["name"],
            )
            assert len(observed) == len(value["expected"])
            maximum_error = 0
            for actual, expected in zip(observed, value["expected"]):
                assert actual["properties"] == expected["properties"]
                assert type(actual["properties"]["value"]) is int
                maximum_error = max(
                    maximum_error,
                    compare_geometry(actual["geometry"], expected["geometry"]),
                )
            filtered_layer = QgsVectorLayer(
                uri.uri(False), "Studio bounded watershed collection", "OAPIF"
            )
            assert filtered_layer.isValid(), filtered_layer.error().summary()
            bounded = list(
                filtered_layer.getFeatures(
                    QgsFeatureRequest().setFilterRect(
                        QgsRectangle(-72.51, 42, -72.39, 42.11)
                    )
                )
            )
            assert len(bounded) == 1 and bounded[0]["name"] == "Watershed 1"
            bounded.clear()
            result = {
                "version": Qgis.QGIS_VERSION,
                "provider": layer.providerType(),
                "crs": layer.crs().authid(),
                "fields": fields,
                "features": observed,
                "bboxFeatureCount": 1,
                "maximumCoordinateErrorDegrees": maximum_error,
                "anonymousRejected": True,
            }
        if value.get("tiles", False):
            endpoint = value["baseUrl"].removesuffix("/ogc") + "/wmts"
            raster_uri = (
                QgsProviderRegistry.instance()
                .providerMetadata("wms")
                .encodeUri(
                    {
                        "url": endpoint
                        + "?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0",
                        "crs": "EPSG:3857",
                        "format": "image/png",
                        "layers": "watersheds",
                        "styles": "default",
                        "tileMatrixSet": "WebMercatorQuad",
                        "dpiMode": "7",
                        "type": "wmts",
                    }
                )
            )
            authenticated = False
            raster_anonymous = QgsRasterLayer(
                raster_uri, "Anonymous watershed tiles", "wms"
            )
            assert not raster_anonymous.isValid(), "Anonymous WMTS access succeeded"
            authenticated = True
            raster = QgsRasterLayer(raster_uri, "Prepared watershed tiles", "wms")
            if value["denied"]:
                assert not raster.isValid(), (
                    "Withdrawn WMTS collection remained available"
                )
                result["wmts"] = {"withdrawnRejected": True, "anonymousRejected": True}
            else:
                assert raster.isValid(), raster.error().summary()
                assert raster.crs().authid() == "EPSG:3857"
                half = 20037508.342789244
                span = 2 * half / 128
                extent = QgsRectangle(
                    -half + 38 * span,
                    half - 48 * span,
                    -half + 39 * span,
                    half - 47 * span,
                )
                block = raster.dataProvider().block(1, extent, 256, 256)
                assert block is not None and block.isValid() and not block.isEmpty()
                colored = sum(
                    qAlpha(block.color(row, col)) > 0
                    and qGreen(block.color(row, col)) > qRed(block.color(row, col))
                    for row in range(256)
                    for col in range(256)
                )
                assert colored > 50, (
                    "The prepared tile did not render the watershed fill"
                )
                result["wmts"] = {
                    "crs": raster.crs().authid(),
                    "width": block.width(),
                    "height": block.height(),
                    "coloredPixels": colored,
                    "anonymousRejected": True,
                }
            block = raster = raster_anonymous = None
        if value.get("maps", False):
            raster_uri = (
                QgsProviderRegistry.instance()
                .providerMetadata("wms")
                .encodeUri(
                    {
                        "url": origin + f"/api/projects/{project}/wms",
                        "crs": "EPSG:3857",
                        "format": "image/png",
                        "layers": "watershed-map",
                        "styles": "",
                        "version": "1.3.0",
                        "dpiMode": "0",
                    }
                )
            )
            authenticated = False
            raster_anonymous = QgsRasterLayer(
                raster_uri, "Anonymous watershed map", "wms"
            )
            assert not raster_anonymous.isValid(), "Anonymous WMS access succeeded"
            authenticated = True
            raster = QgsRasterLayer(raster_uri, "Published watershed map", "wms")
            if value["denied"]:
                assert not raster.isValid(), "Withdrawn WMS layer remained available"
                result["wms"] = {"withdrawnRejected": True, "anonymousRejected": True}
            else:
                assert raster.isValid(), raster.error().summary()
                assert raster.crs().authid() == "EPSG:3857"
                half = 20037508.342789244
                span = 2 * half / 128
                extent = QgsRectangle(
                    -half + 38 * span,
                    half - 48 * span,
                    -half + 39 * span,
                    half - 47 * span,
                )
                block = raster.dataProvider().block(1, extent, 256, 256)
                assert block is not None and block.isValid() and not block.isEmpty()
                colored = sum(
                    qAlpha(block.color(row, col)) > 0
                    and qGreen(block.color(row, col)) > qRed(block.color(row, col))
                    for row in range(256)
                    for col in range(256)
                )
                assert colored > 50, "The WMS image did not render the watershed fill"
                result["wms"] = {
                    "crs": raster.crs().authid(),
                    "width": block.width(),
                    "height": block.height(),
                    "coloredPixels": colored,
                    "anonymousRejected": True,
                }
            block = raster = raster_anonymous = None
        assert not rejected, "QGIS attempted discovery outside the exact local project"
        result["outsideProjectRequests"] = len(rejected)
        print(json.dumps(result, sort_keys=True))
    finally:
        features.clear()
        block = raster = raster_anonymous = None
        layer = anonymous = filtered_layer = None
        gc.collect()
        manager.removeRequestPreprocessor(hook)
        app.processEvents()
        app.exitQgis()


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Acceptance assertions must remain enabled")
    main()
