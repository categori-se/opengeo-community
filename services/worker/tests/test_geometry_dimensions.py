import pytest

from opengeo_worker.geometry_dimensions import declared_layout, dimension_evidence


@pytest.mark.parametrize(
    ("name", "layout"),
    [
        ("Point", "XY"),
        ("PointZ", "XYZ"),
        ("PointM", "XYM"),
        ("MultiLineStringZM", "XYZM"),
        ("UnknownZ", "None"),
        ("3D Point", "XYZ"),
        ("Measured Point", "XYM"),
        ("3D Measured Multi Line String", "XYZM"),
        ("MultiPolygon", "XY"),
        ("Unknown (any)", "None"),
        ("Geometry", "None"),
        ("", "None"),
        (None, "None"),
    ],
)
def test_declared_layout_keeps_z_and_m_distinct(name, layout):
    assert declared_layout(name) == (None if layout == "None" else layout)


def test_mixed_and_unknown_geometry_fields_do_not_claim_uniform_dimension():
    assert dimension_evidence([])["coordinate_dimension"] is None
    value = dimension_evidence([{"type": "3D Point"}, {"type": "Measured Point"}])
    assert value["coordinate_dimension"] == 3
    assert value["coordinate_layouts"] == ["XYM", "XYZ"]
    assert (
        dimension_evidence([{"type": "Point"}, {"type": "3D Point"}])["coordinate_dimension"]
        is None
    )
    assert (
        dimension_evidence([{"type": "Point"}, {"type": "Unknown (any)"}])["coordinate_dimension"]
        is None
    )
