import copy
import json
from pathlib import Path

import pytest

from opengeo_api.map_definitions import _SPATIAL_BODIES, validate_map_definition

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / "fixtures/map-measurements/polygon-3d.json").read_text())


def definition() -> dict:
    return {
        "schemaVersion": "opengeo.map-definition.1.6.0",
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": copy.deepcopy(FIXTURE["records"]),
        "spatialBody": copy.deepcopy(_SPATIAL_BODIES["earth"]),
        "projection": "mercator",
        "colorMode": "light",
        "layers": [],
    }


def test_independent_api_accepts_analytic_vertical_sloping_and_concave_faces() -> None:
    value = definition()
    value["measurements"].append(copy.deepcopy(FIXTURE["boundedRecord"]))
    value["measurements"][-1]["id"] += "-bounded"
    before = copy.deepcopy(value)
    assert validate_map_definition(value, require_current=True) is value
    assert value == before
    assert validate_map_definition(json.loads(json.dumps(value)), require_current=True) == before
    for m, reference in zip(value["measurements"], FIXTURE["cases"], strict=False):
        assert abs(m["summary"]["areaSquareMeters"] - reference["areaSquareMeters"]) < 0.001


@pytest.mark.parametrize(
    "mutation",
    [
        "area",
        "perimeter",
        "width",
        "height",
        "topology",
        "axis",
        "radius",
        "source",
        "bounds",
        "body",
        "legacy",
        "coordinates",
        "bool-index",
    ],
)
def test_api_rejects_forged_summaries_topology_metadata_and_old_version(mutation: str) -> None:
    value = definition()
    m = value["measurements"][0]
    if mutation in {"area", "perimeter", "width", "height"}:
        m["summary"][mutation + ("SquareMeters" if mutation == "area" else "Meters")] += 100
    elif mutation == "topology":
        m["triangles"][0].reverse()
    elif mutation == "axis":
        m["model"]["projectionAxis"] += 0.001
    elif mutation == "radius":
        m["model"]["radiusMeters"] += 1
    elif mutation == "source":
        m["source"]["privateCredential"] = "must-not-be-retained"
    elif mutation == "bounds":
        value["measurements"][0] = copy.deepcopy(FIXTURE["boundedRecord"])
        value["measurements"][0]["bounds"]["areaSquareMeters"][1] -= 100
    elif mutation == "body":
        m["spatialBodyId"] = "mars"
    elif mutation == "legacy":
        value["schemaVersion"] = "opengeo.map-definition.1.3.0"
    elif mutation == "coordinates":
        m["coordinates"][0][2] = 100001
    elif mutation == "bool-index":
        m["triangles"][0][0] = False
    with pytest.raises(ValueError):
        validate_map_definition(value, require_current=True)


def test_native_schema_accepts_bounded_record_and_rejects_extra_measurement_fields() -> None:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource

    schemas = [json.loads(p.read_text()) for p in (ROOT / "schemas").glob("*.schema.json")]
    registry = Registry().with_resources(
        (s["$id"], Resource.from_contents(s)) for s in schemas if "$id" in s
    )
    schema = json.loads((ROOT / "schemas/opengeo-map-definition-1.6.0.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=registry)
    validator.validate(definition())
    bad = definition()
    bad["measurements"][0]["private"] = "credential"
    assert list(validator.iter_errors(bad))
