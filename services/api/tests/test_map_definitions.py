from copy import deepcopy
from uuid import UUID

import pytest

from opengeo_api.map_definitions import (
    LEGACY_MAP_DEFINITION_SCHEMA_VERSION,
    MAP_DEFINITION_SCHEMA_VERSION,
    external_map_configuration,
    map_basemap_connection_references,
    map_dataset_references,
    validate_map_definition,
)

DATASET_ID = UUID("70000000-0000-4000-8000-000000000001")
DATASET_VERSION_ID = UUID("71000000-0000-4000-8000-000000000001")
BASEMAP_BINDING_ID = UUID("c1000000-0000-4000-8000-000000000056")

SPATIAL_BODIES = {
    "moon": {
        "schemaVersion": "opengeo.spatial-body.1.0.0",
        "id": "moon",
        "title": "Moon",
        "coordinateSystem": "east-positive-longitude-planetocentric-latitude-degrees",
        "rendererProjection": "web-mercator-angular",
        "rendererBounds": [-180, -85.05112878, 180, 85.05112878],
        "ellipsoid": {"semiMajorAxisMeters": 1_737_400, "inverseFlattening": 0},
        "measurement": {
            "model": "spherical-mean-radius",
            "distanceUnit": "meter",
            "areaUnit": "square-meter",
        },
        "camera": {"model": "maplibre-angular-zoom", "physicalAltitude": False},
    },
    "mars": {
        "schemaVersion": "opengeo.spatial-body.1.0.0",
        "id": "mars",
        "title": "Mars",
        "coordinateSystem": "east-positive-longitude-planetocentric-latitude-degrees",
        "rendererProjection": "web-mercator-angular",
        "rendererBounds": [-180, -85.05112878, 180, 85.05112878],
        "ellipsoid": {
            "semiMajorAxisMeters": 3_396_190,
            "inverseFlattening": 169.894447,
        },
        "measurement": {
            "model": "spherical-mean-radius",
            "distanceUnit": "meter",
            "areaUnit": "square-meter",
        },
        "camera": {"model": "maplibre-angular-zoom", "physicalAltitude": False},
    },
}


def definition() -> dict:
    return {
        "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
        "mapViews": [
            {
                "id": "primary",
                "title": "Primary view",
                "center": [-77.04, 38.91],
                "zoom": 12,
                "pitch": 0,
                "bearing": 0,
            }
        ],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": "source_roads",
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [
            {
                "layerId": "source_roads",
                "datasetId": str(DATASET_ID),
                "title": "Road tiles",
                "sourceType": "xyz-raster",
                "sourceVersion": 2,
                "sourceUrl": "https://tiles.example.test/{z}/{x}/{y}.png",
                "sourceConfiguration": {
                    "minZoom": 0,
                    "maxZoom": 18,
                    "tileSize": 256,
                    "scheme": "xyz",
                    "attribution": "Example",
                },
                "geometryType": "Raster",
                "bbox": [-180, -85, 180, 85],
                "visible": True,
                "opacity": 0.8,
                "order": 10,
                "style": {},
                "labels": {"enabled": False, "field": None},
            },
            {
                "layerId": "kml-places",
                "datasetId": "kml-places",
                "title": "Places",
                "sourceType": "kml-places",
                "visible": True,
                "opacity": 1,
                "order": 20,
                "style": {},
                "labels": {"enabled": True, "field": "name"},
            },
        ],
        "extensions": {"geolibre": {"schemaVersion": "1.0.0", "project": {}}},
    }


def test_versioned_definition_exposes_only_governed_dataset_references() -> None:
    value = definition()

    assert validate_map_definition(value) is value
    references = map_dataset_references(value)

    assert len(references) == 1
    assert references[0].dataset_id == DATASET_ID
    assert references[0].source_type == "xyz"
    assert references[0].source_version == 2
    assert references[0].source_configuration == value["layers"][0]["sourceConfiguration"]


@pytest.mark.parametrize("renderer", ["maplibre", "mapbox", "cesium"])
def test_renderer_preference_preserves_foreign_extensions(renderer: str) -> None:
    value = definition()
    value["extensions"]["opengeoRenderer"] = {"id": renderer}
    before = deepcopy(value)
    assert validate_map_definition(value, require_current=True) == before


@pytest.mark.parametrize(
    "preference",
    [
        None,
        [],
        {},
        {"id": "unknown"},
        {"id": "pk.never.echo"},
        {"id": "mapbox", "options": {}},
        {"id": "mapbox", "accessToken": "pk.never.echo"},
    ],
)
def test_renderer_preference_rejects_credentials_and_sdk_options(preference: object) -> None:
    value = definition()
    value["extensions"]["opengeoRenderer"] = preference
    with pytest.raises(ValueError) as error:
        validate_map_definition(value, require_current=True)
    assert "pk.never.echo" not in str(error.value)


def test_governed_dataset_layer_exposes_an_exact_logical_version_reference() -> None:
    value = definition()
    layer = value["layers"][0]
    layer["sourceType"] = "governed-dataset"
    layer["sourceVersion"] = 3
    layer["datasetVersionId"] = str(DATASET_VERSION_ID)
    layer.pop("sourceUrl")
    layer.pop("sourceConfiguration")

    assert validate_map_definition(value, require_current=True) is value
    reference = map_dataset_references(value)[0]
    assert reference.dataset_id == DATASET_ID
    assert reference.dataset_version_id == DATASET_VERSION_ID
    assert reference.dataset_version_number == 3
    assert reference.source_type is None


def test_exact_dataset_version_reference_requires_a_governed_dataset_layer() -> None:
    value = definition()
    value["layers"][0]["datasetVersionId"] = str(DATASET_VERSION_ID)

    with pytest.raises(ValueError, match="requires governed-dataset"):
        validate_map_definition(value, require_current=True)


def test_provider_basemap_persists_only_an_exact_binding_and_flavor() -> None:
    value = definition()
    value["basemaps"] = [
        {
            "basemapId": f"provider-protomaps-{BASEMAP_BINDING_ID}-dark",
            "title": "Protomaps Dark",
            "kind": "provider-style",
            "provider": "protomaps",
            "connectionBindingId": str(BASEMAP_BINDING_ID),
            "flavor": "dark",
            "attribution": "Protomaps · © OpenStreetMap contributors",
            "visible": True,
            "opacity": 0.9,
        }
    ]

    assert validate_map_definition(value, require_current=True) is value
    assert map_basemap_connection_references(value) == (BASEMAP_BINDING_ID,)

    with_url = deepcopy(value)
    with_url["basemaps"][0]["styleUrl"] = (
        "https://api.protomaps.com/styles/v5/dark/en.json?key=must-not-persist"
    )
    with pytest.raises(ValueError, match="provider basemap fields"):
        validate_map_definition(with_url, require_current=True)

    mismatched = deepcopy(value)
    mismatched["basemaps"][0]["basemapId"] = f"provider-protomaps-{BASEMAP_BINDING_ID}-light"
    with pytest.raises(ValueError, match="does not match"):
        validate_map_definition(mismatched, require_current=True)

    for unsafe_url in (
        "https://api.protomaps.com/styles/v5/dark/en.json",
        "https://styles.example.test/dark.json?api_key=must-not-persist",
    ):
        unbound = definition()
        unbound["basemaps"] = [
            {
                "basemapId": "unbound-provider",
                "kind": "maplibre-style",
                "url": unsafe_url,
            }
        ]
        with pytest.raises(ValueError, match="reusable provider connection"):
            validate_map_definition(unbound, require_current=True)


def test_carto_basemap_persists_only_an_exact_binding_and_raster_flavor() -> None:
    value = definition()
    value["basemaps"] = [
        {
            "basemapId": f"provider-carto-{BASEMAP_BINDING_ID}-positron",
            "title": "CARTO Positron",
            "kind": "provider-raster",
            "provider": "carto",
            "connectionBindingId": str(BASEMAP_BINDING_ID),
            "flavor": "positron",
            "attribution": "© CARTO · © OpenStreetMap contributors",
            "visible": True,
            "opacity": 1,
        }
    ]

    assert validate_map_definition(value, require_current=True) is value
    assert map_basemap_connection_references(value) == (BASEMAP_BINDING_ID,)

    with_url = deepcopy(value)
    with_url["basemaps"][0]["url"] = (
        "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=must-not-persist"
    )
    with pytest.raises(ValueError, match="provider basemap fields"):
        validate_map_definition(with_url, require_current=True)

    wrong_kind = deepcopy(value)
    wrong_kind["basemaps"][0]["kind"] = "provider-style"
    with pytest.raises(ValueError, match="provider is invalid"):
        validate_map_definition(wrong_kind, require_current=True)


def test_regional_basemap_is_a_governed_exact_source_revision() -> None:
    value = definition()
    configuration = {
        "minZoom": 2,
        "maxZoom": 18,
        "tileSize": 256,
        "scheme": "tms",
        "attribution": "Example mapping agency",
        "presentationRole": "regional_basemap",
        "license": "CC-BY-4.0",
        "coverageBounds": [80, 26, 89, 31],
        "coordinateBehavior": "wgs84_web_mercator",
    }
    value["basemaps"] = [
        {
            "basemapId": f"governed-xyz-{DATASET_ID}-v3",
            "title": "Mountain district imagery",
            "kind": "governed-raster",
            "datasetId": str(DATASET_ID),
            "sourceType": "xyz-raster",
            "sourceVersion": 3,
            "sourceUrl": "https://tiles.example.test/{z}/{x}/{y}.png",
            "sourceConfiguration": configuration,
            "attribution": "Example mapping agency",
            "visible": True,
            "opacity": 0.85,
        }
    ]

    assert validate_map_definition(value, require_current=True) is value
    references = map_dataset_references(value)
    assert len(references) == 2
    assert references[1].dataset_id == DATASET_ID
    assert references[1].source_type == "xyz"
    assert references[1].source_version == 3
    assert references[1].source_configuration == configuration

    offset = deepcopy(value)
    offset["basemaps"][0]["sourceConfiguration"]["coordinateBehavior"] = "gcj02_offset"
    with pytest.raises(ValueError, match="supported transform"):
        validate_map_definition(offset, require_current=True)

    forged = deepcopy(value)
    forged["basemaps"][0]["sourceVersion"] = 4
    with pytest.raises(ValueError, match="basemapId does not match"):
        validate_map_definition(forged, require_current=True)


@pytest.mark.parametrize("body_id", ["moon", "mars"])
def test_planetary_project_requires_an_exact_body_and_visible_blank_canvas(
    body_id: str,
) -> None:
    value = definition()
    value["layers"] = []
    value["activeLayerId"] = None
    value["spatialBody"] = deepcopy(SPATIAL_BODIES[body_id])
    value["basemaps"] = [
        {
            "basemapId": f"planetary-blank-{body_id}",
            "title": f"Blank {body_id} map",
            "kind": "planetary-blank",
            "spatialBodyId": body_id,
            "attribution": f"No imagery · {SPATIAL_BODIES[body_id]['title']} angular canvas",
            "visible": True,
            "opacity": 1,
        }
    ]

    assert validate_map_definition(value, require_current=True) is value
    assert map_dataset_references(value) == ()
    assert map_basemap_connection_references(value) == ()

    forged_radius = deepcopy(value)
    forged_radius["spatialBody"]["ellipsoid"]["semiMajorAxisMeters"] = 6_378_137
    with pytest.raises(ValueError, match="body registry"):
        validate_map_definition(forged_radius, require_current=True)

    hidden = deepcopy(value)
    hidden["basemaps"][0]["visible"] = False
    with pytest.raises(ValueError, match="exactly one visible matching"):
        validate_map_definition(hidden, require_current=True)

    duplicate = deepcopy(value)
    duplicate["basemaps"].append(deepcopy(duplicate["basemaps"][0]))
    with pytest.raises(ValueError, match="exactly one visible matching"):
        validate_map_definition(duplicate, require_current=True)

    with_earth_background = deepcopy(value)
    with_earth_background["basemaps"].append(
        {"basemapId": "blank", "kind": "blank", "visible": True}
    )
    with pytest.raises(ValueError, match="cannot display an Earth basemap"):
        validate_map_definition(with_earth_background, require_current=True)


def test_planetary_canvas_and_spatial_body_must_match() -> None:
    value = definition()
    value["layers"] = []
    value["activeLayerId"] = None
    value["spatialBody"] = deepcopy(SPATIAL_BODIES["moon"])
    value["basemaps"] = [
        {
            "basemapId": "planetary-blank-mars",
            "title": "Blank Martian map",
            "kind": "planetary-blank",
            "spatialBodyId": "mars",
            "attribution": "No imagery · Mars angular canvas",
            "visible": True,
            "opacity": 1,
        }
    ]

    with pytest.raises(ValueError, match="must match spatialBody"):
        validate_map_definition(value, require_current=True)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda value: value.update(schemaVersion="opengeo.map-definition.9.0.0"),
            "schemaVersion",
        ),
        (lambda value: value.pop("projection"), "missing required field projection"),
        (
            lambda value: value["layers"].append(deepcopy(value["layers"][0])),
            "layerId values must be unique",
        ),
        (lambda value: value.update(activeLayerId="missing"), "activeLayerId"),
        (
            lambda value: value["layers"][0].update(datasetId="scratch"),
            "governed UUID",
        ),
        (
            lambda value: value["layers"][0].update(sourceVersion=0),
            "positive integer",
        ),
        (
            lambda value: value["extensions"].update(access_token="do-not-store"),
            "must not contain credentials",
        ),
        (
            lambda value: value["extensions"].update(__proto__={"polluted": True}),
            "forbidden object key",
        ),
    ],
)
def test_versioned_definition_rejects_ambiguous_or_sensitive_state(mutate, message) -> None:
    value = definition()
    mutate(value)

    with pytest.raises(ValueError, match=message):
        validate_map_definition(value)


def test_legacy_definition_remains_readable_during_schema_transition() -> None:
    legacy = {"layers": ["roads"], "bookmarks": []}

    assert validate_map_definition(legacy) == legacy
    assert map_dataset_references(legacy) == ()
    with pytest.raises(ValueError, match="schemaVersion is required for writes"):
        validate_map_definition(legacy, require_current=True)

    versioned_legacy = definition()
    versioned_legacy["schemaVersion"] = LEGACY_MAP_DEFINITION_SCHEMA_VERSION
    versioned_legacy.pop("activeProcessingModelId")
    versioned_legacy.pop("models")
    versioned_legacy.pop("processingHistory")
    versioned_legacy.pop("measurements")
    assert validate_map_definition(versioned_legacy) is versioned_legacy
    with pytest.raises(ValueError, match="for writes"):
        validate_map_definition(versioned_legacy, require_current=True)


def test_current_definition_accepts_bounded_processing_state() -> None:
    value = definition()
    value["activeProcessingModelId"] = "extent-centroid"
    value["models"] = [
        {
            "id": "extent-centroid",
            "name": "Extent centroid",
            "steps": [
                {"id": "extent", "toolId": "bbox-layer", "parameters": {}},
                {"id": "center", "toolId": "centroids", "parameters": {}},
            ],
        }
    ]
    value["processingHistory"] = [
        {
            "id": "run-1",
            "kind": "algorithm",
            "toolId": "centroids",
            "toolName": "Create centroid layer",
            "engine": "browser",
            "parameters": {},
            "inputLayerNames": {"source_roads": "Road tiles"},
            "outputLayerNames": ["Road tile centroids"],
            "startedAt": "2026-08-29T12:00:00.000Z",
            "durationMs": 2,
            "status": "success",
            "opengeo": {
                "schemaVersion": "opengeo.processing-run.1.0.0",
                "toolVersion": "1.0.0",
                "deterministic": True,
                "input": {"layerId": "source_roads"},
                "output": {"featureCount": 1},
                "limits": {"networkAccess": "disabled"},
                "logs": ["Created one centroid."],
            },
        }
    ]

    assert validate_map_definition(value, require_current=True) is value

    missing_model = deepcopy(value)
    missing_model["activeProcessingModelId"] = "missing"
    with pytest.raises(ValueError, match="activeProcessingModelId"):
        validate_map_definition(missing_model, require_current=True)

    duplicate_step = deepcopy(value)
    duplicate_step["models"][0]["steps"][1]["id"] = "extent"
    with pytest.raises(ValueError, match="step ids must be unique"):
        validate_map_definition(duplicate_step, require_current=True)

    widened_receipt = deepcopy(value)
    widened_receipt["processingHistory"][0]["opengeo"]["workerSecret"] = "x"
    with pytest.raises(ValueError, match="receipt fields"):
        validate_map_definition(widened_receipt, require_current=True)


def test_import_plan_allows_only_bounded_pre_revision_placeholders() -> None:
    plan = definition()
    plan["layers"] = [plan["layers"][0]]
    plan["layers"][0]["datasetId"] = "import:source_roads"
    plan["layers"][0]["importRef"] = "geolibre:source_roads"
    plan["layers"][0].pop("sourceVersion")

    assert (
        validate_map_definition(
            plan,
            allow_import_references=True,
            require_current=True,
        )
        == plan
    )
    with pytest.raises(ValueError, match="governed UUID"):
        validate_map_definition(plan, require_current=True)


def test_database_source_configuration_normalizes_to_the_browser_snapshot() -> None:
    assert external_map_configuration(
        "wms",
        {
            "version": "1.3.0",
            "layers": ["public:roads"],
            "styles": [""],
            "format": "image/png",
            "transparent": True,
            "crs": "EPSG:3857",
            "tile_size": 256,
            "attribution": None,
        },
    ) == {
        "version": "1.3.0",
        "layers": ["public:roads"],
        "styles": [""],
        "imageFormat": "image/png",
        "transparent": True,
        "crs": "EPSG:3857",
        "tileSize": 256,
        "attribution": None,
    }

    assert external_map_configuration(
        "xyz",
        {
            "min_zoom": 2,
            "max_zoom": 18,
            "tile_size": 256,
            "scheme": "tms",
            "attribution": "Example mapping agency",
            "presentation_role": "regional_basemap",
            "license": "CC-BY-4.0",
            "coverage_bounds": [80, 26, 89, 31],
            "coordinate_behavior": "wgs84_web_mercator",
        },
    ) == {
        "minZoom": 2,
        "maxZoom": 18,
        "tileSize": 256,
        "scheme": "tms",
        "attribution": "Example mapping agency",
        "presentationRole": "regional_basemap",
        "license": "CC-BY-4.0",
        "coverageBounds": [80, 26, 89, 31],
        "coordinateBehavior": "wgs84_web_mercator",
    }


def test_versioned_portal_configuration_is_saved_as_bounded_map_state() -> None:
    value = definition()
    value["portal"] = portal_configuration()

    assert validate_map_definition(value, require_current=True) is value
    assert value["portal"]["sources"][0]["element"]["name"] == "map-source"
    assert value["portal"]["catalog"][0]["children"][0]["source"] == "roads/default"
    assert value["portal"]["tools"][0]["children"][0]["type"] == "service"


def test_portal_catalog_binding_uses_a_governed_exact_source_layer() -> None:
    value = definition()
    value["portal"] = portal_configuration()
    layer = value["layers"][0]
    layer.update(
        sourceType="wms-raster",
        sourceUrl="https://maps.example.test/wms",
        sourceConfiguration={
            "version": "1.3.0",
            "layers": ["default"],
            "styles": [],
            "imageFormat": "image/png",
            "transparent": True,
            "crs": "EPSG:3857",
            "tileSize": 256,
            "attribution": None,
        },
        portalCatalogSource="roads/default",
    )

    assert validate_map_definition(value, require_current=True) is value
    reference = map_dataset_references(value)[0]
    assert reference.dataset_id == DATASET_ID
    assert reference.source_type == "wms"
    assert reference.source_version == 2


@pytest.mark.parametrize(
    ("reference", "source_type", "message"),
    [
        ("missing/default", "wms-raster", "identify a configured catalog layer"),
        ("roads/default", "xyz-raster", "source type does not match"),
        ("roads/default", "governed-dataset", "governed external source"),
    ],
)
def test_portal_catalog_binding_rejects_unresolved_or_ungoverned_layers(
    reference: str, source_type: str, message: str
) -> None:
    value = definition()
    value["portal"] = portal_configuration()
    value["layers"][0]["portalCatalogSource"] = reference
    value["layers"][0]["sourceType"] = source_type

    with pytest.raises(ValueError, match=message):
        validate_map_definition(value, require_current=True)


def test_portal_catalog_layer_may_have_only_one_binding() -> None:
    value = definition()
    value["portal"] = portal_configuration()
    layer = value["layers"][0]
    layer.update(
        sourceType="wms-raster",
        sourceUrl="https://maps.example.test/wms",
        sourceConfiguration={
            "version": "1.3.0",
            "layers": ["default"],
            "styles": [],
            "imageFormat": "image/png",
            "transparent": True,
            "crs": "EPSG:3857",
            "tileSize": 256,
            "attribution": None,
        },
        portalCatalogSource="roads/default",
    )
    duplicate = deepcopy(layer)
    duplicate["layerId"] = "second_roads"
    duplicate["datasetId"] = "70000000-0000-4000-8000-000000000002"
    value["layers"].append(duplicate)

    with pytest.raises(ValueError, match="bound only once"):
        validate_map_definition(value, require_current=True)


def test_portal_catalog_binding_requires_a_portal_configuration() -> None:
    value = definition()
    value["layers"][0]["portalCatalogSource"] = "roads/default"

    with pytest.raises(ValueError, match="requires a portal configuration"):
        validate_map_definition(value, require_current=True)


def test_portal_catalog_binding_requires_one_declared_source_layer() -> None:
    value = definition()
    value["portal"] = portal_configuration()
    value["portal"]["catalog"][0]["children"][0]["source"] = "roads/missing"
    layer = value["layers"][0]
    layer.update(
        sourceType="wms-raster",
        sourceUrl="https://maps.example.test/wms",
        sourceConfiguration={},
        portalCatalogSource="roads/missing",
    )

    with pytest.raises(ValueError, match="resolve to one declared portal source layer"):
        validate_map_definition(value, require_current=True)


def test_portal_source_identity_matches_its_preserved_map_source() -> None:
    value = definition()
    value["portal"] = portal_configuration()
    value["portal"]["sources"][0]["element"]["attributes"]["type"] = "xyz"

    with pytest.raises(ValueError, match="identity must match"):
        validate_map_definition(value, require_current=True)


def test_versioned_portal_configuration_rejects_credential_bearing_url_text() -> None:
    value = definition()
    value["portal"] = portal_configuration()
    value["portal"]["sources"][0]["element"]["children"].append(
        {
            "name": "url",
            "attributes": {},
            "text": "https://user:password@example.test/wms?token=secret",
            "children": [],
        }
    )

    with pytest.raises(ValueError, match="must not contain credentials"):
        validate_map_definition(value, require_current=True)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda portal: portal.update(revision=0), "revision"),
        (
            lambda portal: portal["sources"].append(deepcopy(portal["sources"][0])),
            "source names must be unique",
        ),
        (
            lambda portal: portal["sources"][0]["element"]["attributes"].update(
                {"bad name": "value"}
            ),
            "attribute name",
        ),
        (
            lambda portal: portal["theme"].update(colorMode="sepia"),
            "colorMode",
        ),
        (
            lambda portal: portal.update(extra="unbounded"),
            "unsupported fields",
        ),
    ],
)
def test_versioned_portal_configuration_rejects_ambiguous_state(mutate, message) -> None:
    value = definition()
    value["portal"] = portal_configuration()
    mutate(value["portal"])

    with pytest.raises(ValueError, match=message):
        validate_map_definition(value, require_current=True)


def portal_configuration() -> dict:
    return {
        "schemaVersion": "opengeo.portal-configuration.1.0.0",
        "revision": 1,
        "sources": [
            {
                "name": "roads",
                "type": "wms",
                "title": "Roads",
                "element": {
                    "name": "map-source",
                    "attributes": {"name": "roads", "type": "wms"},
                    "text": "",
                    "children": [
                        {
                            "name": "layer",
                            "attributes": {"name": "default", "status": "on"},
                            "text": "",
                            "children": [],
                        }
                    ],
                },
            }
        ],
        "catalog": [
            {
                "kind": "group",
                "title": "Operational layers",
                "source": None,
                "attributes": {"title": "Operational layers"},
                "metadata": [],
                "children": [
                    {
                        "kind": "layer",
                        "title": "Roads",
                        "source": "roads/default",
                        "attributes": {"src": "roads/default", "title": "Roads"},
                        "metadata": [],
                        "children": [],
                    }
                ],
            }
        ],
        "tools": [
            {
                "kind": "drawer",
                "name": "searches",
                "title": "Search",
                "type": "drawer",
                "tip": None,
                "href": None,
                "cssClass": None,
                "attributes": {"name": "searches", "title": "Search"},
                "children": [
                    {
                        "kind": "tool",
                        "name": "search-roads",
                        "title": "Search roads",
                        "type": "service",
                        "tip": None,
                        "href": None,
                        "cssClass": None,
                        "attributes": {
                            "name": "search-roads",
                            "title": "Search roads",
                            "type": "service",
                        },
                        "children": [],
                    }
                ],
            }
        ],
        "searches": [
            {
                "name": "search-roads",
                "title": "Search roads",
                "service": "search-roads",
            }
        ],
        "services": [{"name": "search-roads", "title": "Search roads"}],
        "locations": [{"id": "home", "title": "Home", "center": [-93.2, 44.9], "zoom": 8}],
        "theme": {"id": "default", "title": "Default", "colorMode": "dark"},
        "upstream": {
            "product": "geomoose",
            "version": "3.15.2",
            "commit": "6eb12a80c9d379b5634126da6ad047071fa85b92",
        },
    }


def test_style_reference_requires_versioned_identity_and_native_binding_contract() -> None:
    document = definition()
    document["schemaVersion"] = "opengeo.map-definition.1.4.0"
    reference = {
        "projectId": "50000000-0000-4000-8000-000000000002",
        "resourceId": "a0000000-0000-4000-8000-000000000002",
        "styleId": "d0000000-0000-4000-8000-000000000002",
        "versionNumber": 2,
        "checksumSha256": "a" * 64,
        "format": "maplibre",
    }
    document["layers"][0]["styleReference"] = reference
    validate_map_definition(document, require_current=True)
    for field, value in [
        ("versionNumber", True),
        ("versionNumber", 0),
        ("versionNumber", 9007199254740992),
        ("checksumSha256", "bad"),
        ("projectId", "not-uuid"),
        ("format", "unknown"),
    ]:
        invalid = deepcopy(document)
        invalid["layers"][0]["styleReference"][field] = value
        with pytest.raises(ValueError, match="styleReference"):
            validate_map_definition(invalid)
    validate_map_definition(document, allow_import_references=True)
    imported = deepcopy(document)
    imported["layers"][0]["importRef"] = "geolibre:derived"
    with pytest.raises(ValueError, match="native"):
        validate_map_definition(imported, allow_import_references=True)
    document["schemaVersion"] = MAP_DEFINITION_SCHEMA_VERSION
    with pytest.raises(ValueError, match=r"1\.4\.0"):
        validate_map_definition(document)


MANAGED_DISPLAY_ID = UUID("72000000-0000-4000-8000-000000000001")


def managed_display_definition():
    document = definition()
    document["schemaVersion"] = "opengeo.map-definition.1.5.0"
    layer = document["layers"][0]
    layer.update(
        sourceType="governed-dataset",
        datasetVersionId=str(DATASET_VERSION_ID),
        sourceVersion=3,
        managedDisplayId=str(MANAGED_DISPLAY_ID),
    )
    layer.pop("sourceUrl")
    layer.pop("sourceConfiguration")
    return document


def test_native15_preserves_exact_managed_display_reference_and_prior_style_contract():
    document = managed_display_definition()
    document["layers"][0]["styleReference"] = {
        "projectId": "50000000-0000-4000-8000-000000000002",
        "resourceId": "a0000000-0000-4000-8000-000000000002",
        "styleId": "d0000000-0000-4000-8000-000000000002",
        "versionNumber": 2,
        "checksumSha256": "a" * 64,
        "format": "maplibre",
    }
    before = deepcopy(document)
    assert validate_map_definition(document, require_current=True) == before
    reference = map_dataset_references(document)[0]
    assert reference.dataset_id == DATASET_ID
    assert reference.dataset_version_id == DATASET_VERSION_ID
    assert reference.dataset_version_number == 3
    assert reference.managed_display_id == MANAGED_DISPLAY_ID
    assert "ticket" not in document["layers"][0]


@pytest.mark.parametrize(
    "changes",
    [
        {"managedDisplayId": None},
        {"managedDisplayId": "not-a-uuid"},
        {"managedDisplayId": {"id": str(MANAGED_DISPLAY_ID), "ticket": "must-not-persist"}},
        {"datasetVersionId": None},
        {"sourceType": "geojson-object"},
        {"sourceVersion": 0},
        {"sourceVersion": True},
        {"sourceVersion": None},
    ],
)
def test_saved_display_requires_uuid_and_exact_governed_source_version(changes):
    document = managed_display_definition()
    document["layers"][0].update(changes)
    with pytest.raises(ValueError):
        validate_map_definition(document, require_current=True)


def test_managed_display_is_native15_layer_only_and_not_unresolved_import():
    document = managed_display_definition()
    document["schemaVersion"] = "opengeo.map-definition.1.4.0"
    with pytest.raises(ValueError, match=r"1\.5\.0"):
        validate_map_definition(document, require_current=True)
    document = managed_display_definition()
    document["layers"][0]["importRef"] = "geolibre:derived"
    with pytest.raises(ValueError, match="resolved governed"):
        validate_map_definition(document, allow_import_references=True)
    document = managed_display_definition()
    document["basemaps"] = [{"basemapId": "plain", "managedDisplayId": str(MANAGED_DISPLAY_ID)}]
    with pytest.raises(ValueError, match="only on governed dataset Layers"):
        validate_map_definition(document, require_current=True)
    document = managed_display_definition()
    document.pop("models")
    with pytest.raises(ValueError, match="models"):
        validate_map_definition(document, require_current=True)
