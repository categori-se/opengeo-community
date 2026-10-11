import pytest

from opengeo_api.map_filters import validate_map_filter


@pytest.mark.parametrize(
    "value",
    [
        None,
        ["==", ["get", "name"], "Park"],
        ["==", "name", "Park"],
        ["all", ["has", "name"], ["!", ["==", ["get", "value"], None]]],
    ],
)
def test_valid(value):
    assert validate_map_filter(value) is value


@pytest.mark.parametrize(
    "value",
    [
        ["get", "name"],
        ["==", ["get", ["var", "field"]], "x"],
        ["==", ["get", "x"], {}],
        ["all"],
        ["==", ["get", "x"], float("inf")],
    ],
)
def test_invalid(value):
    with pytest.raises(ValueError):
        validate_map_filter(value)


def test_depth():
    value = ["has", "name"]
    for _ in range(10):
        value = ["!", value]
    with pytest.raises(ValueError):
        validate_map_filter(value)


@pytest.mark.parametrize("values", [["A", "B"], [1, 2.5]])
def test_membership(values):
    value = ["!", ["in", ["get", "value"], ["literal", values]]]
    assert validate_map_filter(value) == value


@pytest.mark.parametrize("values", [[], [True], [None], ["A", 1], ["A"] * 65, [float("inf")]])
def test_invalid_membership(values):
    with pytest.raises(ValueError):
        validate_map_filter(["in", ["get", "value"], ["literal", values]])
