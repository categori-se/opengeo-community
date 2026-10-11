import json

import pytest

from opengeo_api.cql2_features import Cql2Invalid, compile_feature_filter, scalar_queryables

FIELDS = {"name": "string", "value": "number", "active": "boolean", "group": "group"}


def test_text_and_json_produce_identical_bound_typed_predicates():
    text = "value >= 2 AND name = 'O''Brien'"
    document = {
        "op": "and",
        "args": [
            {"op": ">=", "args": [{"property": "value"}, 2]},
            {"op": "=", "args": [{"property": "name"}, "O'Brien"]},
        ],
    }
    sql, parameters = compile_feature_filter(text, "cql2-text", FIELDS)
    assert (sql, parameters) == compile_feature_filter(json.dumps(document), "cql2-json", FIELDS)
    assert parameters == ("value", 2, "name", "O'Brien")
    assert "O'Brien" not in sql and "value" not in sql
    assert "::numeric" in sql and " AND " in sql


def test_null_logic_and_explicit_false_values():
    sql, parameters = compile_feature_filter(
        "NOT (name IS NULL OR active = FALSE)", "cql2-text", FIELDS
    )
    assert "NOT" in sql and "IS NULL" in sql and "::boolean" in sql
    assert parameters == ("name", "active", False)


def test_in_and_between_preserve_parameter_order():
    sql, parameters = compile_feature_filter(
        "value BETWEEN 1 AND 4 AND name IN ('a', 'b')", "cql2-text", FIELDS
    )
    assert "BETWEEN" in sql and "IN" in sql
    assert parameters == ("value", 1, 4, "name", "a", "b")


@pytest.mark.parametrize(
    "expression",
    [
        "unknown = 1",
        "group = 'x'",
        "value = '2'",
        "active = 1",
        "value LIKE '%x%'",
        "value + 1 = 2",
        "value = name",
        "active > TRUE",
        "value =",
        " OR ".join(["value = 1"] * 40),
        "x" * 10001,
    ],
)
def test_invalid_unsupported_and_over_budget_filters_fail_closed(expression):
    with pytest.raises(Cql2Invalid):
        compile_feature_filter(expression, "cql2-text", FIELDS)


def test_queryables_excludes_groups_and_does_not_accept_unknown_properties():
    document = scalar_queryables(FIELDS, "https://example.test/queryables")
    assert set(document["properties"]) == {"name", "value", "active"}
    assert document["additionalProperties"] is False


def test_json_property_names_are_bound_even_if_schema_has_sql_like_names():
    name = "x'); DROP TABLE app.dataset_features; --"
    sql, parameters = compile_feature_filter(
        json.dumps({"op": "=", "args": [{"property": name}, "literal"]}),
        "cql2-json",
        {name: "string"},
    )
    assert name not in sql and parameters == (name, "literal")


def test_invalid_numeric_and_property_shapes_fail_closed():
    for value in [float("inf"), float("nan"), 10**400]:
        with pytest.raises(Cql2Invalid):
            compile_feature_filter(
                json.dumps({"op": "=", "args": [{"property": "value"}, value]}),
                "cql2-json",
                FIELDS,
            )
    with pytest.raises(Cql2Invalid):
        compile_feature_filter(
            json.dumps({"op": "=", "args": [{"property": []}, 1]}), "cql2-json", FIELDS
        )


def test_boolean_precedence_matches_explicit_json_structure():
    document = {
        "op": "or",
        "args": [
            {"op": "=", "args": [{"property": "name"}, "x"]},
            {
                "op": "and",
                "args": [
                    {"op": "=", "args": [{"property": "active"}, True]},
                    {"op": ">", "args": [{"property": "value"}, 2]},
                ],
            },
        ],
    }
    assert compile_feature_filter(
        "name = 'x' OR active = TRUE AND value > 2", "cql2-text", FIELDS
    ) == compile_feature_filter(json.dumps(document), "cql2-json", FIELDS)


@pytest.mark.parametrize("pattern", ["a%", "a_", r"a\%", r"a\_", r"a\\b", "a.b"])
def test_like_uses_standard_wildcards_and_bound_escape(pattern):
    text = f"name LIKE '{pattern}'"
    document = {"op": "like", "args": [{"property": "name"}, pattern]}
    sql, params = compile_feature_filter(text, "cql2-text", FIELDS)
    assert (sql, params) == compile_feature_filter(json.dumps(document), "cql2-json", FIELDS)
    assert params == ("name", pattern, chr(92))
    assert "LIKE %s ESCAPE %s" in sql


def test_incomplete_like_escape_rejects_before_database():
    with pytest.raises(Cql2Invalid):
        compile_feature_filter(
            json.dumps({"op": "like", "args": [{"property": "name"}, "a" + chr(92)]}),
            "cql2-json",
            FIELDS,
        )


def test_property_comparisons_reverse_literals_and_single_letter_identifiers():
    fields = {**FIELDS, "x": "integer"}
    sql, params = compile_feature_filter("2 < x AND x <= value", "cql2-text", fields)
    assert params == (2, "x", "x", "value")
    assert " < " in sql and " <= " in sql
    for expression in ["x = name", "active < active", "1 = 1"]:
        with pytest.raises(Cql2Invalid):
            compile_feature_filter(expression, "cql2-text", fields)


@pytest.mark.parametrize(
    "operator",
    ["INTERSECTS", "DISJOINT", "WITHIN", "CONTAINS", "TOUCHES", "CROSSES", "OVERLAPS", "EQUALS"],
)
def test_spatial_text_json_bind_geometry_and_preserve_operand_order(operator):
    document = {
        "op": f"s_{operator.lower()}",
        "args": [{"type": "Point", "coordinates": [1, 2]}, {"property": "geometry"}],
    }
    text = f"S_{operator}(POINT(1 2), geometry)"
    sql, params = compile_feature_filter(text, "cql2-text", FIELDS, spatial=True)
    assert (sql, params) == compile_feature_filter(
        json.dumps(document), "cql2-json", FIELDS, spatial=True
    )
    assert sql.endswith(", feature.geometry)")
    assert json.loads(params[0]) == {"type": "Point", "coordinates": [1, 2]}


def test_bbox_order_dateline_and_degenerate_geometry():
    for bbox, kind in [
        ([0, 1, 3, 4], "Polygon"),
        ([175, -5, -175, 5], "GeometryCollection"),
        ([1, 2, 1, 2], "Point"),
        ([1, 2, 1, 3], "LineString"),
    ]:
        text = f"S_INTERSECTS(geometry, BBOX({','.join(map(str, bbox))}))"
        document = {"op": "s_intersects", "args": [{"property": "geometry"}, {"bbox": bbox}]}
        result = compile_feature_filter(text, "cql2-text", FIELDS, spatial=True)
        assert result == compile_feature_filter(
            json.dumps(document), "cql2-json", FIELDS, spatial=True
        )
        assert json.loads(result[1][0])["type"] == kind


@pytest.mark.parametrize(
    "expression",
    [
        "S_INTERSECTS(name, POINT(1 2))",
        "S_INTERSECTS(geometry, POINT(181 0))",
        "S_INTERSECTS(geometry, POINT(1 2 3))",
        "S_WITHIN(geometry, BBOX(1,4,3,2))",
        "S_DWITHIN(geometry, POINT(1 2), 1, meters)",
    ],
)
def test_invalid_spatial_shapes_reject(expression):
    with pytest.raises(Cql2Invalid):
        compile_feature_filter(expression, "cql2-text", FIELDS, spatial=True)


def test_geometry_queryable_is_reserved_only_for_spatial_collections():
    fields = {"geometry": "string"}
    assert scalar_queryables(fields, "local", spatial=True)["properties"]["geometry"] == {
        "format": "geometry-any",
        "x-ogc-role": "primary-geometry",
    }
    with pytest.raises(Cql2Invalid):
        compile_feature_filter("geometry = 'text'", "cql2-text", fields, spatial=True)
    with pytest.raises(Cql2Invalid):
        compile_feature_filter("S_INTERSECTS(geometry, POINT(1 2))", "cql2-text", fields)
