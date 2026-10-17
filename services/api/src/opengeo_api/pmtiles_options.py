"""Closed GDAL PMTiles v2 parameters; paired with the worker contract."""

import math
import re
from typing import Any

PMTILES_OPTIONS_DEFAULTS: dict[str, Any] = {
    "input_layer": None,
    "extent": 4096,
    "simplification": 1,
    "simplification_max_zoom": 1,
    "buffer": 80,
    "max_size": 500_000,
    "max_features": 200_000,
    "attribute_names": None,
}
_FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_.:-]{0,99}\Z")


def normalize_pmtiles_options(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - set(PMTILES_OPTIONS_DEFAULTS):
        raise ValueError("Unknown PMTiles conversion option")
    result = {**PMTILES_OPTIONS_DEFAULTS, **value}
    layer = result["input_layer"]
    if layer is not None and (
        not isinstance(layer, str)
        or not 1 <= len(layer) <= 200
        or layer != layer.strip()
        or layer.startswith("-")
        or any(ord(char) < 32 or ord(char) == 127 for char in layer)
    ):
        raise ValueError("Invalid PMTiles input layer")
    for key, minimum, maximum in (
        ("buffer", 0, 256),
        ("max_size", 50_000, 2_000_000),
        ("max_features", 1_000, 500_000),
    ):
        if type(result[key]) is not int or not minimum <= result[key] <= maximum:
            raise ValueError(f"Invalid PMTiles {key}")
    if type(result["extent"]) is not int or result["extent"] not in (2048, 4096, 8192):
        raise ValueError("Invalid PMTiles extent")
    for key in ("simplification", "simplification_max_zoom"):
        number = result[key]
        if (
            isinstance(number, bool)
            or not isinstance(number, (int, float))
            or not math.isfinite(number)
            or not 0 <= number <= 10
        ):
            raise ValueError(f"Invalid PMTiles {key}")
    fields = result["attribute_names"]
    if fields is not None:
        if (
            not isinstance(fields, list)
            or not 1 <= len(fields) <= 128
            or any(not isinstance(field, str) or not _FIELD.fullmatch(field) for field in fields)
            or len(set(fields)) != len(fields)
        ):
            raise ValueError("Invalid PMTiles attribute selection")
        result["attribute_names"] = list(fields)
    return result
