from __future__ import annotations

import math

import pytest

from opengeo_api.map_definitions import (
    _SPATIAL_BODIES,
    MAP_DEFINITION_SCHEMA_VERSION,
    PATH_MAP_DEFINITION_SCHEMA_VERSION,
    PROCESSING_MAP_DEFINITION_SCHEMA_VERSION,
    _path_distance_meters,
    validate_map_definition,
)


def current_definition() -> dict:
    body = _SPATIAL_BODIES["earth"]
    coordinates = [[-71.1, 42.3], [-71.099, 42.3005]]
    horizontal = _path_distance_meters(coordinates, body)
    measurement = {
        "schemaVersion": "opengeo.path-measurement.1.0.0",
        "id": "measurement_001",
        "title": "Ridge route",
        "kind": "path-profile",
        "spatialBodyId": "earth",
        "measurementModel": "spherical-mean-radius",
        "distanceUnit": "meter",
        "coordinates": coordinates,
        "horizontalDistanceMeters": round(horizontal, 6),
        "terrainProfile": {
            "status": "complete",
            "source": {
                "sourceId": "opengeo-mapterhorn-terrain",
                "provider": "Mapterhorn",
                "queryMode": "renderer-unexaggerated-point-sample",
                "termsUrl": "https://mapterhorn.com/attribution/",
                "observedAt": "2026-08-28",
            },
            "samples": [
                {
                    "distanceMeters": 0,
                    "coordinate": coordinates[0],
                    "elevationMeters": 10,
                },
                {
                    "distanceMeters": round(horizontal, 6),
                    "coordinate": coordinates[1],
                    "elevationMeters": 20,
                },
            ],
            "summary": {
                "threeDimensionalDistanceMeters": round(math.hypot(horizontal, 10), 6),
                "minimumElevationMeters": 10,
                "maximumElevationMeters": 20,
                "ascentMeters": 10,
                "descentMeters": 0,
            },
        },
    }
    return {
        "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [measurement],
        "spatialBody": body,
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [],
    }


def test_current_map_accepts_recomputed_saved_path_and_terrain_profile() -> None:
    definition = current_definition()

    assert validate_map_definition(definition, require_current=True) is definition


def test_current_map_accepts_independently_recomputed_polygon_and_circle() -> None:
    definition = current_definition()
    identity = {
        "schemaVersion": "opengeo.area-measurement.1.0.0",
        "spatialBodyId": "earth",
        "measurementModel": "spherical-mean-radius",
        "distanceUnit": "meter",
        "areaUnit": "square-meter",
    }
    definition["measurements"].extend(
        [
            {
                **identity,
                "id": "polygon_001",
                "title": "Survey area",
                "kind": "polygon-area",
                "coordinates": [
                    [-71.11, 42.30],
                    [-71.10, 42.30],
                    [-71.10, 42.31],
                    [-71.11, 42.31],
                ],
                "perimeterMeters": 3868.63774,
                "areaSquareMeters": 914432.836402,
            },
            {
                **identity,
                "id": "circle_001",
                "title": "Impact radius",
                "kind": "circle-area",
                "center": [-71.10, 42.30],
                "radiusPoint": [-71.09, 42.30],
                "radiusMeters": 822.433385,
                "circumferenceMeters": 5167.501348,
                "areaSquareMeters": 2124962.806644,
            },
        ]
    )

    assert validate_map_definition(definition, require_current=True) is definition


@pytest.mark.parametrize(
    "field, delta, message",
    [("perimeterMeters", 1, "perimeter"), ("areaSquareMeters", 1, "area")],
)
def test_current_map_rejects_forged_polygon_summaries(field: str, delta: int, message: str) -> None:
    definition = current_definition()
    definition["measurements"] = [
        {
            "schemaVersion": "opengeo.area-measurement.1.0.0",
            "id": "polygon_001",
            "title": "Survey area",
            "kind": "polygon-area",
            "spatialBodyId": "earth",
            "measurementModel": "spherical-mean-radius",
            "distanceUnit": "meter",
            "areaUnit": "square-meter",
            "coordinates": [
                [-71.11, 42.30],
                [-71.10, 42.30],
                [-71.10, 42.31],
                [-71.11, 42.31],
            ],
            "perimeterMeters": 3868.63774,
            "areaSquareMeters": 914432.836402,
        }
    ]
    definition["measurements"][0][field] += delta

    with pytest.raises(ValueError, match=message):
        validate_map_definition(definition, require_current=True)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["measurements"][0].update(
            {"horizontalDistanceMeters": value["measurements"][0]["horizontalDistanceMeters"] + 20}
        ),
        lambda value: value["measurements"][0]["terrainProfile"]["source"].update(
            {"termsUrl": "http://localhost/terrain"}
        ),
        lambda value: value["measurements"][0]["terrainProfile"]["summary"].update(
            {"ascentMeters": 100}
        ),
        lambda value: value["measurements"][0].update({"spatialBodyId": "mars"}),
        lambda value: value["measurements"][0]["terrainProfile"]["samples"][1].update(
            {"distanceMeters": 1}
        ),
    ],
)
def test_current_map_rejects_forged_measurement_contract(mutate) -> None:
    definition = current_definition()
    mutate(definition)

    with pytest.raises(ValueError, match=r"measurement|terrain"):
        validate_map_definition(definition, require_current=True)


def test_previous_processing_schema_is_readable_but_upgrades_before_write() -> None:
    definition = current_definition()
    definition["schemaVersion"] = PROCESSING_MAP_DEFINITION_SCHEMA_VERSION
    definition.pop("measurements")

    assert validate_map_definition(definition) is definition
    with pytest.raises(ValueError, match="schemaVersion"):
        validate_map_definition(definition, require_current=True)


def test_previous_path_schema_remains_readable_but_cannot_store_area_measurements() -> None:
    definition = current_definition()
    definition["schemaVersion"] = PATH_MAP_DEFINITION_SCHEMA_VERSION

    assert validate_map_definition(definition) is definition
    with pytest.raises(ValueError, match="schemaVersion"):
        validate_map_definition(definition, require_current=True)

    definition["measurements"][0]["kind"] = "polygon-area"
    with pytest.raises(ValueError, match="not available"):
        validate_map_definition(definition)


def test_current_map_requires_explicit_measurement_inventory() -> None:
    definition = current_definition()
    definition.pop("measurements")

    with pytest.raises(ValueError, match="measurements"):
        validate_map_definition(definition, require_current=True)
