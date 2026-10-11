"""Conservative dimension evidence from GDAL's declared geometry type names.

This records layer declarations, not a scan of every coordinate. Z and M remain
separate even though XYZ and XYM both have three ordinates. Unknown type names
never imply XY.
"""

_TYPES = frozenset(
    {
        "Point",
        "LineString",
        "Polygon",
        "MultiPoint",
        "MultiLineString",
        "MultiPolygon",
        "GeometryCollection",
        "CircularString",
        "CompoundCurve",
        "CurvePolygon",
        "MultiCurve",
        "MultiSurface",
        "PolyhedralSurface",
        "TIN",
        "Triangle",
    }
)


def declared_layout(type_name: object) -> str | None:
    if not isinstance(type_name, str):
        return None
    # ogrinfo JSON uses ISO suffixes (PointZ); human-readable names use prefixes.
    for suffix in ("ZM", "Z", "M"):
        if type_name.endswith(suffix) and type_name[: -len(suffix)] in _TYPES:
            return "XY" + suffix
    name = type_name
    has_z = name.startswith("3D ")
    if has_z:
        name = name[3:]
    has_m = name.startswith("Measured ")
    if has_m:
        name = name[9:]
    if name.replace(" ", "") not in _TYPES:
        return None
    return "XY" + ("Z" if has_z else "") + ("M" if has_m else "")


def dimension_evidence(geometry_fields: list[object]) -> dict[str, object]:
    declarations = []
    for field in geometry_fields:
        value = field if isinstance(field, dict) else {}
        name = value.get("type")
        declarations.append(
            {
                "declared_type": name if isinstance(name, str) else None,
                "coordinate_layout": declared_layout(name),
            }
        )
    layouts = [item["coordinate_layout"] for item in declarations]
    dimensions = {len(value) for value in layouts if isinstance(value, str)}
    known = bool(layouts) and all(value is not None for value in layouts)
    return {
        "geometry_fields": declarations,
        "coordinate_layouts": sorted(set(layouts)) if known else None,
        "coordinate_dimension": next(iter(dimensions)) if known and len(dimensions) == 1 else None,
        "coordinate_dimension_basis": "ogrinfo declared geometry types",
    }
