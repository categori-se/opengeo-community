"""Bounded 3D face verification. No geometry library, data transport or account I/O.

The client chooses a valid triangulation; the API checks its complete oriented
boundary and independently recomputes every metric and conservative height bound.
"""

import math
from collections import defaultdict
from collections.abc import Callable
from typing import Any, cast


def validate_polygon3d_measurement(
    value: dict[str, Any],
    body_id: str,
    radius: float,
    horizontal_distance: Callable[[list[float], list[float]], float],
) -> None:
    def reject() -> None:
        raise ValueError("3D polygon measurement is invalid")

    def number(x: Any) -> bool:
        return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)

    def text(x: Any, maximum: int) -> bool:
        return (
            isinstance(x, str)
            and 0 < len(x) <= maximum
            and x.strip() == x
            and all(ord(c) >= 32 for c in x)
        )

    expected_keys = {
        "schemaVersion",
        "id",
        "title",
        "kind",
        "spatialBodyId",
        "measurementModel",
        "distanceUnit",
        "areaUnit",
        "coordinates",
        "triangles",
        "source",
        "uncertaintyMeters",
        "model",
        "summary",
        "bounds",
    }
    if (
        set(value) != expected_keys
        or value["schemaVersion"] != "opengeo.polygon-3d-measurement.1.0.0"
        or value["kind"] != "polygon-3d"
        or value["spatialBodyId"] != body_id
        or value["measurementModel"] != "mean-sphere-radial-elevation-chords"
        or value["distanceUnit"] != "meter"
        or value["areaUnit"] != "square-meter"
        or not text(value["title"], 200)
    ):
        reject()
    coordinates, source, u = value["coordinates"], value["source"], value["uncertaintyMeters"]
    if (
        not isinstance(coordinates, list)
        or not 3 <= len(coordinates) <= 128
        or any(
            not isinstance(c, list)
            or len(c) != 3
            or not all(number(v) for v in c)
            or abs(c[0]) > 180
            or abs(c[1]) > 85.05112878
            or abs(c[2]) > 100000
            for c in coordinates
        )
        or len({tuple(c) for c in coordinates}) != len(coordinates)
        or (u is not None and (not number(u) or not 0 <= u <= 1000))
    ):
        reject()
    if (
        not isinstance(source, dict)
        or set(source) != {"kind", "label", "verticalDatum", "geometryMeasurementId"}
        or source["kind"] != "user-supplied-vertices"
        or not text(source["label"], 200)
        or not text(source["verticalDatum"], 120)
    ):
        reject()
    # The caller validates all measurement IDs with the existing identifier rule.
    parent = source["geometryMeasurementId"]
    if parent is not None:
        import re

        if (
            not isinstance(parent, str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", parent) is None
        ):
            reject()

    def unit(c: list[float]) -> list[float]:
        lon, lat = math.radians(c[0]), math.radians(c[1])
        return [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)]

    def dot(a: list[float], b: list[float]) -> float:
        return sum(x * y for x, y in zip(a, b, strict=True))

    def sub(a: list[float], b: list[float]) -> list[float]:
        return [x - y for x, y in zip(a, b, strict=True)]

    def cross(a: list[float], b: list[float]) -> list[float]:
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

    origin = unit(coordinates[0])
    lon, lat = math.radians(coordinates[0][0]), math.radians(coordinates[0][1])
    east = [-math.sin(lon), math.cos(lon), 0.0]
    north = [-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)]
    normals = [[dot(unit(c), east), dot(unit(c), north), dot(unit(c), origin)] for c in coordinates]
    points = [
        [(radius + c[2]) * v[0], (radius + c[2]) * v[1], radius * (v[2] - 1) + c[2] * v[2]]
        for c, v in zip(coordinates, normals, strict=True)
    ]
    if any(math.hypot(*sub(p, points[0])) > 100000 for p in points):
        reject()
    n = len(points)
    normal = [sum(cross(points[i], points[(i + 1) % n])[k] for i in range(n)) for k in range(3)]
    length = math.hypot(*normal)
    if length < 1e-8:
        reject()
    axis = max(range(3), key=lambda k: abs(normal[k]))
    projected = [[v for k, v in enumerate(p) if k != axis] for p in points]

    def det(a: list[float], b: list[float], c: list[float]) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    for i in range(n):
        for j in range(i):
            if math.hypot(*sub(projected[i], projected[j])) < 1e-6:
                reject()
            if i == j + 1 or (j == 0 and i == n - 1):
                continue
            a, b, c, d = projected[i], projected[(i + 1) % n], projected[j], projected[(j + 1) % n]
            if any(
                max(a[k], b[k]) < min(c[k], d[k]) - 1e-8 or max(c[k], d[k]) < min(a[k], b[k]) - 1e-8
                for k in range(2)
            ):
                continue
            if det(a, b, c) * det(a, b, d) <= 1e-8 and det(c, d, a) * det(c, d, b) <= 1e-8:
                reject()
    signed_area = (
        sum(
            p[0] * projected[(i + 1) % n][1] - p[1] * projected[(i + 1) % n][0]
            for i, p in enumerate(projected)
        )
        / 2
    )
    if abs(signed_area) < 1e-8:
        reject()
    triangles = value["triangles"]
    if not isinstance(triangles, list) or len(triangles) != n - 2:
        reject()
    edges: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    triangle_area = 0.0
    for t in triangles:
        if (
            not isinstance(t, list)
            or len(t) != 3
            or any(not isinstance(k, int) or isinstance(k, bool) or not 0 <= k < n for k in t)
            or len(set(t)) != 3
        ):
            reject()
        area = det(*(projected[k] for k in t)) / 2
        if area * (1 if signed_area > 0 else -1) <= 1e-8:
            reject()
        triangle_area += area
        for i in range(3):
            a, b = t[i], t[(i + 1) % 3]
            edges[min(a, b), max(a, b)].append((a, b))
    for i in range(n):
        j = (i + 1) % n
        if edges.pop((min(i, j), max(i, j)), None) != [(i, j)]:
            reject()
    if any(len(e) != 2 or e[0] != e[1][::-1] for e in edges.values()) or abs(
        triangle_area - signed_area
    ) > max(1e-6, abs(signed_area) * 1e-9):
        reject()
    perimeter = sum(math.hypot(*sub(points[(i + 1) % n], p)) for i, p in enumerate(points))
    area = sum(
        math.hypot(*cross(sub(points[b], points[a]), sub(points[c], points[a]))) / 2
        for a, b, c in triangles
    )
    width = max(
        horizontal_distance(coordinates[i][:2], coordinates[j][:2])
        for i in range(n)
        for j in range(i)
    )
    height = max(c[2] for c in coordinates) - min(c[2] for c in coordinates)
    deviation = max(abs(dot(sub(p, points[0]), normal)) / length for p in points)
    expected_model = {
        "surface": "vertex-triangulated",
        "projectionAxis": axis,
        "radiusMeters": radius,
        "maximumPlaneDeviationMeters": deviation,
        "verticalAccuracy": "not-declared",
        "uncertainty": "conservative-radial-intervals",
        "betweenVertices": "planar-facets",
    }

    def close(actual: Any, expected: Any, path: str = "") -> bool:
        if isinstance(expected, (int, float)):
            tolerance = (
                (0.1 if "areaSquareMeters" in path else 0.01)
                if "summary" in path or "bounds" in path
                else 0
                if path.endswith("projectionAxis")
                else 1e-6
            )
            return number(actual) and abs(actual - expected) <= tolerance
        if isinstance(expected, dict):
            return (
                isinstance(actual, dict)
                and set(actual) == set(expected)
                and all(close(actual[k], v, path + "." + k) for k, v in expected.items())
            )
        if isinstance(expected, list):
            return (
                isinstance(actual, list)
                and len(actual) == len(expected)
                and all(close(a, b, path) for a, b in zip(actual, expected, strict=True))
            )
        return cast(bool, actual == expected)

    summary = {
        "perimeterMeters": perimeter,
        "areaSquareMeters": area,
        "widthMeters": width,
        "heightMeters": height,
    }
    if not close(value["summary"], summary, "summary") or not close(
        value["model"], expected_model, "model"
    ):
        reject()
    bounds = None
    if u is not None:

        def edge(i: int, j: int) -> list[list[float]]:
            return [
                [
                    v - u * (abs(normals[i][k]) + abs(normals[j][k])),
                    v + u * (abs(normals[i][k]) + abs(normals[j][k])),
                ]
                for k, v in enumerate(sub(points[j], points[i]))
            ]

        def norm(v: list[list[float]]) -> list[float]:
            return [
                math.hypot(*(0 if a <= 0 <= b else min(abs(a), abs(b)) for a, b in v)),
                math.hypot(*(max(abs(a), abs(b)) for a, b in v)),
            ]

        def multiply(a: list[float], b: list[float]) -> list[float]:
            v = [x * y for x in a for y in b]
            return [min(v), max(v)]

        length_bounds = [norm(edge(i, (i + 1) % n)) for i in range(n)]
        area_bounds = []
        for a, b, c in triangles:
            x, y = edge(a, b), edge(a, c)
            vector = []
            for i, j in [(1, 2), (2, 0), (0, 1)]:
                v, w = multiply(x[i], y[j]), multiply(x[j], y[i])
                vector.append([v[0] - w[1], v[1] - w[0]])
            area_bounds.append([v / 2 for v in norm(vector)])
        bounds = {
            "perimeterMeters": [
                max(0, sum(v[0] for v in length_bounds) - 1e-6),
                sum(v[1] for v in length_bounds) + 1e-6,
            ],
            "areaSquareMeters": [
                max(0, sum(v[0] for v in area_bounds) - 1e-6),
                sum(v[1] for v in area_bounds) + 1e-6,
            ],
            "heightMeters": [max(0, height - 2 * u), height + 2 * u],
        }
    if not close(value["bounds"], bounds, "bounds"):
        reject()
