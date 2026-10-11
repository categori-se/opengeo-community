"""Bounded CQL2 scalar predicates for the existing PostgreSQL feature store.

Shared by authorized dataset and published-service OGC feature routes.
No SQL text supplied by a caller is interpolated into the returned predicate.
"""

import json
import math
from collections.abc import Mapping
from functools import lru_cache
from importlib.metadata import version
from pathlib import Path
from typing import Any

MAX_FILTER_BYTES = 10_000
MAX_NODES = 256
MAX_DEPTH = 32
MAX_BINDS = 512
_TYPES = {"string", "integer", "number", "boolean"}


class Cql2Invalid(ValueError):
    """Unsupported, invalid or over-budget filter."""


def scalar_queryables(
    fields: Mapping[str, str], identifier: str, *, spatial: bool = False
) -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2019-09/schema",
        "$id": identifier,
        "type": "object",
        "title": "Feature queryables",
        "properties": {
            **{
                name: {"type": kind}
                for name, kind in fields.items()
                if kind in _TYPES and (not spatial or name != "geometry")
            },
            **(
                {"geometry": {"format": "geometry-any", "x-ogc-role": "primary-geometry"}}
                if spatial
                else {}
            ),
        },
        "additionalProperties": False,
    }


@lru_cache(maxsize=1)
def _text_parser() -> Any:
    # Narrow grammar corrections for the reviewed MIT-licensed 0.4.0 parser.
    # Keep upstream AST, transformer, literal and geometry parsing. The shipped
    # grammar otherwise gives AND/OR equal precedence, restricts NOT to one
    # predicate and cannot decode SQL-style doubled apostrophes.
    from lark import Lark
    from pygeofilter.parsers.cql2_text import parser as upstream  # type: ignore[import-untyped]

    if version("pygeofilter") != "0.4.0":
        raise Cql2Invalid("unreviewed CQL2 parser version")
    grammar_path = Path(upstream.__file__).with_name("grammar.lark")
    grammar = grammar_path.read_text()
    start, end = grammar.index("?condition:"), grammar.index("?predicate:")
    grammar = (
        grammar[:start]
        + """?condition: conjunction
          | condition "OR"i conjunction -> or_
?conjunction: negation
          | conjunction "AND"i negation -> and_
?negation: predicate
          | "NOT"i negation -> not_
          | "(" condition ")"

"""
        + grammar[end:]
    )
    grammar = grammar.replace('SINGLE_QUOTED: "\'" /.*?/ "\'"', "SINGLE_QUOTED: /'(?:[^']|'')*'/")

    grammar = grammar.replace("/[a-zA-Z][a-zA-Z_:0-9.]+/", "/[a-zA-Z][a-zA-Z_:0-9.]*/")

    class Transformer(upstream.CQLTransformer):  # type: ignore[misc]  # untyped upstream base
        def SINGLE_QUOTED(self, token: Any) -> str:
            return str(token[1:-1]).replace("''", "'")

    return Lark(
        grammar,
        parser="lalr",
        maybe_placeholders=False,
        transformer=Transformer(),
        import_paths=[str(grammar_path.parent.parent)],
    )


def compile_feature_filter(
    expression: str,
    language: str,
    fields: Mapping[str, str],
    *,
    spatial: bool = False,
    geometry_literals: list[dict[str, Any]] | None = None,
) -> tuple[str, tuple[Any, ...]]:
    if not isinstance(expression, str) or not 1 <= len(expression.encode()) <= MAX_FILTER_BYTES:
        raise Cql2Invalid("filter must contain 1 to 10000 UTF-8 bytes")
    if language not in {"cql2-text", "cql2-json"}:
        raise Cql2Invalid("unsupported filter language")
    # Delayed until called: unchanged feature reads do not initialize a parser.
    from pygeofilter import ast, values  # type: ignore[import-untyped]
    from pygeofilter.parsers.cql2_json import parse as parse_json  # type: ignore[import-untyped]

    try:
        tree = (
            parse_json(_normalize_json_boxes(json.loads(expression)))
            if language == "cql2-json"
            else _text_parser().parse(expression)
        )
    except Exception as error:
        raise Cql2Invalid("invalid CQL2 expression") from error

    parameters: list[Any] = []
    nodes = 0

    def bind(value: Any) -> str:
        if len(parameters) >= MAX_BINDS:
            raise Cql2Invalid("filter bind limit exceeded")
        parameters.append(value)
        return "%s"

    def attribute(node: Any) -> tuple[str, str]:
        if (
            not isinstance(node, ast.Attribute)
            or fields.get(node.name) not in _TYPES
            or (spatial and node.name == "geometry")
        ):
            raise Cql2Invalid("property is not an advertised scalar queryable")
        kind = fields[node.name]
        value = f"(feature.properties ->> {bind(node.name)})"
        if kind in {"integer", "number"}:
            value += "::numeric"
        elif kind == "boolean":
            value += "::boolean"
        else:
            value += ' COLLATE "C"'
        return value, kind

    def literal(value: Any, kind: str) -> str:
        valid = (
            (kind == "string" and isinstance(value, str))
            or (kind == "boolean" and isinstance(value, bool))
            or (
                kind in {"integer", "number"}
                and type(value) in {int, float}
                and math.isfinite(value)
            )
        )
        if not valid:
            raise Cql2Invalid("literal type does not match queryable")
        return bind(value)

    def spatial_operand(node: Any) -> str:
        if isinstance(node, ast.Attribute):
            if not spatial or node.name != "geometry":
                raise Cql2Invalid("spatial predicates require the geometry queryable")
            return "feature.geometry"
        if isinstance(node, ast.Function) and str(node.name).lower() == "bbox":
            document = _bbox_geometry(node.arguments)
        elif isinstance(node, values.Geometry):
            document = node.geometry
        else:
            raise Cql2Invalid("spatial operand must be a geometry or BBOX literal")
        # Reuse the feature store's bounded, two-dimensional CRS84 validation.
        # Convert upstream WKT coordinate tuples to ordinary JSON arrays.
        from opengeo_api.features import FeatureInvalid, normalize_query_geometry

        try:
            document = normalize_query_geometry(json.loads(json.dumps(document)))
        except (FeatureInvalid, ValueError, TypeError, OverflowError) as error:
            raise Cql2Invalid("invalid two-dimensional CRS84 geometry literal") from error
        if geometry_literals is not None:
            geometry_literals.append(document)
        return f"ST_SetSRID(ST_GeomFromGeoJSON({bind(json.dumps(document))}::text),4326)"

    def walk(node: Any, depth: int = 0) -> str:
        nonlocal nodes
        nodes += 1
        if nodes > MAX_NODES or depth > MAX_DEPTH:
            raise Cql2Invalid("filter complexity limit exceeded")
        if isinstance(node, (ast.And, ast.Or)):
            op = "AND" if isinstance(node, ast.And) else "OR"
            return f"({walk(node.lhs, depth + 1)} {op} {walk(node.rhs, depth + 1)})"
        if isinstance(node, ast.Not):
            return f"(NOT {walk(node.sub_node, depth + 1)})"
        if isinstance(node, ast.SpatialComparisonPredicate):
            functions = {
                "INTERSECTS": "ST_Intersects",
                "DISJOINT": "ST_Disjoint",
                "CONTAINS": "ST_Contains",
                "WITHIN": "ST_Within",
                "TOUCHES": "ST_Touches",
                "CROSSES": "ST_Crosses",
                "OVERLAPS": "ST_Overlaps",
                "EQUALS": "ST_Equals",
            }
            function = functions.get(node.op.value)
            if (
                not spatial
                or function is None
                or not any(isinstance(value, ast.Attribute) for value in (node.lhs, node.rhs))
            ):
                raise Cql2Invalid("spatial predicate must reference geometry")
            return f"{function}({spatial_operand(node.lhs)}, {spatial_operand(node.rhs)})"
        if isinstance(node, ast.Comparison):
            lhs_attribute = isinstance(node.lhs, ast.Attribute)
            rhs_attribute = isinstance(node.rhs, ast.Attribute)
            if not lhs_attribute and not rhs_attribute:
                raise Cql2Invalid("comparison must reference a queryable")
            op = node.op.value
            if op not in {"=", "<>", "<", "<=", ">", ">="}:
                raise Cql2Invalid("unsupported comparison")
            if lhs_attribute:
                lhs, kind = attribute(node.lhs)
                if rhs_attribute:
                    rhs, rhs_kind = attribute(node.rhs)
                    if kind != rhs_kind and {kind, rhs_kind} != {"integer", "number"}:
                        raise Cql2Invalid("incompatible queryable types")
                else:
                    rhs = literal(node.rhs, kind)
            else:
                # Preserve operand order, including the order of bound parameters.
                reverse_kind = fields.get(node.rhs.name)
                if reverse_kind is None or reverse_kind not in _TYPES:
                    raise Cql2Invalid("property is not an advertised scalar queryable")
                lhs = literal(node.lhs, reverse_kind)
                rhs, kind = attribute(node.rhs)
            if kind == "boolean" and op not in {"=", "<>"}:
                raise Cql2Invalid("boolean ordering is unsupported")
            return f"({lhs} {op} {rhs})"
        if isinstance(node, ast.Like):
            lhs, kind = attribute(node.lhs)
            if kind != "string" or not isinstance(node.pattern, str) or node.nocase:
                raise Cql2Invalid("LIKE requires a string queryable and pattern")
            # CQL2 mandates SQL wildcards (% and _) and backslash escape.
            # Do not inherit pygeofilter's legacy singlechar='.' default.
            trailing = len(node.pattern) - len(node.pattern.rstrip("\\"))
            if trailing % 2:
                raise Cql2Invalid("LIKE pattern ends with an incomplete escape")
            return (
                f"({lhs} {'NOT ' if node.not_ else ''}LIKE "
                f"{bind(node.pattern)} ESCAPE {bind(chr(92))})"
            )
        if isinstance(node, ast.IsNull):
            lhs, _kind = attribute(node.lhs)
            return f"({lhs} IS {'NOT ' if node.not_ else ''}NULL)"
        if isinstance(node, ast.Between):
            lhs, kind = attribute(node.lhs)
            if kind == "boolean":
                raise Cql2Invalid("boolean ordering is unsupported")
            return (
                f"({lhs} {'NOT ' if node.not_ else ''}BETWEEN "
                f"{literal(node.low, kind)} AND {literal(node.high, kind)})"
            )
        if isinstance(node, ast.In):
            lhs, kind = attribute(node.lhs)
            if not 1 <= len(node.sub_nodes) <= MAX_NODES:
                raise Cql2Invalid("IN list limit exceeded")
            values = ", ".join(literal(value, kind) for value in node.sub_nodes)
            return f"({lhs} {'NOT ' if node.not_ else ''}IN ({values}))"
        raise Cql2Invalid("unsupported CQL2 operator")

    try:
        predicate = walk(tree)
    except (TypeError, OverflowError, RecursionError) as error:
        raise Cql2Invalid("invalid or over-budget CQL2 expression") from error
    return predicate, tuple(parameters)


def _bbox_geometry(bounds: Any) -> dict[str, Any]:
    if (
        not isinstance(bounds, (list, tuple))
        or len(bounds) != 4
        or any(type(v) not in {int, float} or not math.isfinite(v) for v in bounds)
    ):
        raise Cql2Invalid("BBOX requires four finite CRS84 coordinates")
    west, south, east, north = bounds
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= north <= 90):
        raise Cql2Invalid("BBOX coordinates are outside CRS84 or reversed vertically")
    if west > east:
        return {
            "type": "GeometryCollection",
            "geometries": [
                _bbox_geometry([west, south, 180, north]),
                _bbox_geometry([-180, south, east, north]),
            ],
        }
    if west == east and south == north:
        return {"type": "Point", "coordinates": [west, south]}
    if west == east or south == north:
        return {"type": "LineString", "coordinates": [[west, south], [east, north]]}
    return {
        "type": "Polygon",
        "coordinates": [
            [[west, south], [east, south], [east, north], [west, north], [west, south]]
        ],
    }


def _normalize_json_boxes(value: Any, depth: int = 0) -> Any:
    if depth > MAX_DEPTH:
        raise Cql2Invalid("filter complexity limit exceeded")
    if isinstance(value, dict):
        from pygeofilter.values import Geometry  # type: ignore[import-untyped]

        if set(value) == {"bbox"}:
            return Geometry(_bbox_geometry(value["bbox"]))
        if value.get("type") == "GeometryCollection":
            return Geometry(value)
        return {key: _normalize_json_boxes(child, depth + 1) for key, child in value.items()}
    if isinstance(value, list):
        return [_normalize_json_boxes(child, depth + 1) for child in value]
    return value
