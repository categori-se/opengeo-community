import argparse
import json
import math
import re
import shlex
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any

MAPSERVER_VERSION = "8.6.5"
MAPSERVER_COMMIT = "d25c31936f3f67911a56560e95ed2c8a7cb8ab4f"
MAXIMUM_MAPFILE_BYTES = 49_152
MAXIMUM_MAPSCRIPT_BYTES = 16_384
MAXIMUM_STATEMENTS = 512
MAXIMUM_DEPTH = 12
MAXIMUM_LAYERS = 16
MAXIMUM_CLASSES = 16
REQUEST_LIMITS = {
    "requests_per_minute": 60,
    "concurrent_requests_per_project": 4,
    "maximum_layers_per_request": 16,
    "maximum_width": 2_048,
    "maximum_height": 2_048,
    "maximum_pixels": 4_194_304,
    "maximum_runtime_seconds": 8,
}

_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9._:-]{0,99}")
_BLOCKS = {
    "MAP",
    "WEB",
    "METADATA",
    "PROJECTION",
    "OUTPUTFORMAT",
    "LEGEND",
    "LABEL",
    "LAYER",
    "CLASS",
    "STYLE",
    "REFERENCE",
    "SCALEBAR",
    "QUERYMAP",
    "CLUSTER",
    "COMPOSITE",
    "LEADER",
    "GRID",
    "JOIN",
    "FEATURE",
    "SYMBOL",
}
_SUPPORTED_BLOCKS = {
    "MAP",
    "WEB",
    "METADATA",
    "PROJECTION",
    "OUTPUTFORMAT",
    "LEGEND",
    "LABEL",
    "LAYER",
    "CLASS",
    "STYLE",
}
_REJECTED_DIRECTIVES = {
    "CONFIG",
    "INCLUDE",
    "PLUGIN",
    "TEMPLATE",
    "HEADER",
    "FOOTER",
}
_DETACHED_DIRECTIVES = {
    "CONNECTION",
    "CONNECTIONTYPE",
    "DATA",
    "TILEINDEX",
    "TILEITEM",
    "SHAPEPATH",
    "SYMBOLSET",
    "FONTSET",
    "PROCESSING",
}
_SUPPORTED_DIRECTIVES: dict[str, set[str]] = {
    "MAP": {
        "NAME",
        "STATUS",
        "EXTENT",
        "SIZE",
        "UNITS",
        "IMAGETYPE",
        "IMAGECOLOR",
        "TRANSPARENT",
        "RESOLUTION",
        "DEFRESOLUTION",
        "MAXSIZE",
    },
    "WEB": set(),
    "METADATA": {"WMS_TITLE", "WMS_SRS", "WMS_ABSTRACT", "WMS_ATTRIBUTION_TITLE"},
    "PROJECTION": {"__VALUE__"},
    "OUTPUTFORMAT": {"NAME", "DRIVER", "MIMETYPE", "IMAGEMODE", "EXTENSION", "TRANSPARENT"},
    "LEGEND": {"STATUS", "POSITION", "KEYSIZE", "KEYSPACING"},
    "LAYER": {
        "NAME",
        "TYPE",
        "STATUS",
        "GROUP",
        "CLASSITEM",
        "LABELITEM",
        "MINSCALEDENOM",
        "MAXSCALEDENOM",
        "OPACITY",
    },
    "CLASS": {"NAME", "EXPRESSION", "MINSCALEDENOM", "MAXSCALEDENOM"},
    "STYLE": {
        "COLOR",
        "OUTLINECOLOR",
        "WIDTH",
        "SIZE",
        "SYMBOL",
        "OPACITY",
        "LINECAP",
        "LINEJOIN",
        "PATTERN",
    },
    "LABEL": {
        "TYPE",
        "SIZE",
        "COLOR",
        "OUTLINECOLOR",
        "OUTLINEWIDTH",
        "POSITION",
        "PARTIALS",
        "MINDISTANCE",
        "REPEATDISTANCE",
        "ANGLE",
        "FONT",
    },
}


class MapServerConfigurationInvalid(ValueError):
    pass


class MapServerConfigurationUnsafe(ValueError):
    def __init__(self, directive: str) -> None:
        self.directive = directive
        super().__init__("mapserver_configuration_unsafe")


@dataclass(slots=True)
class _Directive:
    name: str
    values: tuple[str, ...]
    line: int


@dataclass(slots=True)
class _Node:
    kind: str
    line: int
    directives: list[_Directive] = field(default_factory=list)
    children: list["_Node"] = field(default_factory=list)

    def values(self, name: str) -> tuple[str, ...] | None:
        upper = name.upper()
        for directive in self.directives:
            if directive.name == upper:
                return directive.values
        return None

    def children_of(self, kind: str) -> list["_Node"]:
        upper = kind.upper()
        return [child for child in self.children if child.kind == upper]


@dataclass(frozen=True, slots=True)
class MapServerConfigurationConversion:
    style_definition: str
    canonical_mapfile: str
    geometry_layer_id: str
    label_layer_id: str | None
    minimum_scale_denominator: float | None
    maximum_scale_denominator: float | None
    include_legend: bool
    report: dict[str, Any]
    request_limits: dict[str, int]


def convert_mapserver_configuration(
    mapfile: str,
    *,
    layer_name: str | None = None,
    mapscript: str | None = None,
) -> MapServerConfigurationConversion:
    encoded = _utf8(mapfile, "mapserver_mapfile_utf8_invalid")
    if not 2 <= len(encoded) <= MAXIMUM_MAPFILE_BYTES or "\x00" in mapfile:
        raise MapServerConfigurationInvalid("mapserver_mapfile_size_invalid")
    if any(ord(character) < 32 and character not in "\n\r\t" for character in mapfile):
        raise MapServerConfigurationInvalid("mapserver_mapfile_control_character")
    script_bytes = b"" if mapscript is None else _utf8(mapscript, "mapscript_utf8_invalid")
    if len(script_bytes) > MAXIMUM_MAPSCRIPT_BYTES or (mapscript and "\x00" in mapscript):
        raise MapServerConfigurationInvalid("mapscript_size_invalid")

    root, parser_losses, removed_bindings = _parse(mapfile)
    layers = root.children_of("LAYER")
    if not 1 <= len(layers) <= MAXIMUM_LAYERS:
        raise MapServerConfigurationInvalid("mapserver_layer_count_invalid")
    selected = _select_layer(layers, layer_name)
    selected_name = _one_identifier(selected, "NAME", "mapserver_layer_name_invalid")
    classes = selected.children_of("CLASS")
    if not 1 <= len(classes) <= MAXIMUM_CLASSES:
        raise MapServerConfigurationInvalid("mapserver_class_count_invalid")

    losses = list(parser_losses)
    style = _compile_style(root, selected, classes, losses)
    canonical_mapfile = _canonical_mapfile(root, selected)
    canonical_sha = sha256(canonical_mapfile.encode("utf-8")).hexdigest()
    source_sha = sha256(encoded).hexdigest()
    script_report = {
        "supplied": bool(script_bytes),
        "executed": False,
        "stored": False,
        "bytes": len(script_bytes),
        "sha256": sha256(script_bytes).hexdigest() if script_bytes else None,
        "outcome": "reported_not_executed" if script_bytes else "not_supplied",
    }
    report = {
        "schema_version": "opengeo.mapserver-conversion-report.1.0.0",
        "source_product": "MapServer",
        "source_version": MAPSERVER_VERSION,
        "source_commit": MAPSERVER_COMMIT,
        "source_sha256": source_sha,
        "selected_layer": selected_name,
        "preserved": sorted(set(style.pop("_preserved"))),
        "losses": losses,
        "removed_data_bindings": sorted(set(removed_bindings)),
        "mapscript": script_report,
        "canonical_mapfile_sha256": canonical_sha,
        "unsupported_semantics_execute": False,
        "status": (
            "converted_with_declared_losses"
            if losses or removed_bindings or script_bytes
            else "converted"
        ),
    }
    style["metadata"] = {
        "opengeo": {
            "mapserver_adapter": {
                "source_product": "MapServer",
                "source_version": MAPSERVER_VERSION,
                "source_commit": MAPSERVER_COMMIT,
                "source_sha256": source_sha,
                "canonical_mapfile": canonical_mapfile,
                "canonical_mapfile_sha256": canonical_sha,
                "selected_layer": selected_name,
                "losses": losses,
                "removed_data_bindings": sorted(set(removed_bindings)),
                "mapscript": script_report,
                "request_limits": REQUEST_LIMITS,
            }
        }
    }
    style_definition = json.dumps(style, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(style_definition.encode("utf-8")) > MAXIMUM_MAPFILE_BYTES:
        raise MapServerConfigurationInvalid("mapserver_converted_style_too_large")
    geometry_id = style["layers"][0]["id"]
    label_id = style["layers"][1]["id"] if len(style["layers"]) > 1 else None
    return MapServerConfigurationConversion(
        style_definition=style_definition,
        canonical_mapfile=canonical_mapfile,
        geometry_layer_id=geometry_id,
        label_layer_id=label_id,
        minimum_scale_denominator=_optional_number(selected, "MINSCALEDENOM"),
        maximum_scale_denominator=_optional_number(selected, "MAXSCALEDENOM"),
        include_legend=bool(root.children_of("LEGEND")),
        report=report,
        request_limits=dict(REQUEST_LIMITS),
    )


def export_mapserver_configuration(style_definition: str) -> tuple[str, dict[str, Any]]:
    try:
        document = json.loads(style_definition)
        adapter = document["metadata"]["opengeo"]["mapserver_adapter"]
        mapfile = adapter["canonical_mapfile"]
        expected = adapter["canonical_mapfile_sha256"]
    except (KeyError, TypeError, ValueError) as error:
        raise MapServerConfigurationInvalid("mapserver_adapter_metadata_missing") from error
    if (
        not isinstance(document, dict)
        or not isinstance(adapter, dict)
        or not isinstance(mapfile, str)
        or not isinstance(expected, str)
        or adapter.get("source_product") != "MapServer"
        or adapter.get("source_version") != MAPSERVER_VERSION
        or adapter.get("source_commit") != MAPSERVER_COMMIT
    ):
        raise MapServerConfigurationInvalid("mapserver_adapter_metadata_invalid")
    actual = sha256(_utf8(mapfile, "mapserver_adapter_metadata_invalid")).hexdigest()
    if actual != expected:
        raise MapServerConfigurationInvalid("mapserver_export_checksum_mismatch")
    root, parser_losses, removed_bindings = _parse(mapfile)
    layers = root.children_of("LAYER")
    if parser_losses or removed_bindings or len(layers) != 1:
        raise MapServerConfigurationInvalid("mapserver_export_not_detached")
    if _canonical_mapfile(root, layers[0]) != mapfile:
        raise MapServerConfigurationInvalid("mapserver_export_not_canonical")
    reconverted = convert_mapserver_configuration(mapfile)
    expected_document = json.loads(reconverted.style_definition)
    if any(
        document.get(key) != expected_document.get(key) for key in ("version", "sources", "layers")
    ):
        raise MapServerConfigurationInvalid("mapserver_export_style_changed")
    source_sha = adapter.get("source_sha256")
    if not isinstance(source_sha, str) or re.fullmatch(r"[0-9a-f]{64}", source_sha) is None:
        raise MapServerConfigurationInvalid("mapserver_adapter_metadata_invalid")
    losses = _validated_losses(adapter.get("losses"))
    removed = _validated_removed_bindings(adapter.get("removed_data_bindings"))
    script_report = _validated_mapscript_report(adapter.get("mapscript"))
    if adapter.get("request_limits") != REQUEST_LIMITS:
        raise MapServerConfigurationInvalid("mapserver_adapter_limits_changed")
    report = {
        "schema_version": "opengeo.mapserver-export-report.1.0.0",
        "target_product": "MapServer",
        "target_version": MAPSERVER_VERSION,
        "canonical_mapfile_sha256": actual,
        "source_sha256": source_sha,
        "losses": losses,
        "removed_data_bindings": removed,
        "mapscript": script_report,
        "request_limits": dict(REQUEST_LIMITS),
        "status": "exported_detached_configuration",
    }
    return mapfile, report


def _validated_losses(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > MAXIMUM_STATEMENTS:
        raise MapServerConfigurationInvalid("mapserver_adapter_losses_invalid")
    validated: list[dict[str, Any]] = []
    for loss in value:
        if not isinstance(loss, dict) or set(loss) != {"code", "directive", "path", "line"}:
            raise MapServerConfigurationInvalid("mapserver_adapter_losses_invalid")
        code = loss["code"]
        directive = loss["directive"]
        path = loss["path"]
        line = loss["line"]
        if (
            not isinstance(code, str)
            or re.fullmatch(r"[a-z][a-z0-9_]{2,63}", code) is None
            or not isinstance(directive, str)
            or re.fullmatch(r"[A-Z_]{1,40}", directive) is None
            or not isinstance(path, str)
            or len(path) > 200
            or re.fullmatch(r"[A-Z0-9_\[\]/-]+", path) is None
            or not isinstance(line, int)
            or isinstance(line, bool)
            or not 1 <= line <= MAXIMUM_STATEMENTS
        ):
            raise MapServerConfigurationInvalid("mapserver_adapter_losses_invalid")
        validated.append({"code": code, "directive": directive, "path": path, "line": line})
    return validated


def _utf8(value: str, code: str) -> bytes:
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise MapServerConfigurationInvalid(code) from error


def _validated_removed_bindings(value: Any) -> list[str]:
    if (
        not isinstance(value, list)
        or any(not isinstance(item, str) or item not in _DETACHED_DIRECTIVES for item in value)
        or value != sorted(set(value))
    ):
        raise MapServerConfigurationInvalid("mapserver_adapter_bindings_invalid")
    return list(value)


def _validated_mapscript_report(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "supplied",
        "executed",
        "stored",
        "bytes",
        "sha256",
        "outcome",
    }:
        raise MapServerConfigurationInvalid("mapserver_adapter_mapscript_invalid")
    supplied = value["supplied"]
    byte_count = value["bytes"]
    script_sha = value["sha256"]
    outcome = value["outcome"]
    if (
        not isinstance(supplied, bool)
        or value["executed"] is not False
        or value["stored"] is not False
        or not isinstance(byte_count, int)
        or isinstance(byte_count, bool)
        or not 0 <= byte_count <= MAXIMUM_MAPSCRIPT_BYTES
        or supplied != (byte_count > 0)
        or (
            supplied
            and (
                not isinstance(script_sha, str) or re.fullmatch(r"[0-9a-f]{64}", script_sha) is None
            )
        )
        or (not supplied and script_sha is not None)
        or outcome != ("reported_not_executed" if supplied else "not_supplied")
    ):
        raise MapServerConfigurationInvalid("mapserver_adapter_mapscript_invalid")
    return {
        "supplied": supplied,
        "executed": False,
        "stored": False,
        "bytes": byte_count,
        "sha256": script_sha,
        "outcome": outcome,
    }


def _parse(mapfile: str) -> tuple[_Node, list[dict[str, Any]], list[str]]:
    roots: list[_Node] = []
    stack: list[_Node] = []
    losses: list[dict[str, Any]] = []
    removed: list[str] = []
    statements = 0
    for line_number, raw_line in enumerate(mapfile.splitlines(), 1):
        line = _strip_comment(raw_line).strip()
        if not line:
            continue
        if len(line.encode("utf-8")) > 1_024:
            raise MapServerConfigurationInvalid("mapserver_line_too_large")
        statements += 1
        if statements > MAXIMUM_STATEMENTS:
            raise MapServerConfigurationInvalid("mapserver_statement_limit")
        tokens = _split(line)
        if not tokens:
            continue
        keyword = tokens[0].upper()
        if keyword == "END":
            if len(tokens) != 1 or not stack:
                raise MapServerConfigurationInvalid("mapserver_end_unbalanced")
            stack.pop()
            continue
        if keyword in _BLOCKS:
            if len(tokens) != 1 or len(stack) >= MAXIMUM_DEPTH:
                raise MapServerConfigurationInvalid("mapserver_block_invalid")
            node = _Node(keyword, line_number)
            if stack:
                stack[-1].children.append(node)
            else:
                roots.append(node)
            stack.append(node)
            if keyword not in _SUPPORTED_BLOCKS:
                losses.append(_loss("unsupported_block", keyword, _path(stack), line_number))
            continue
        if not stack:
            raise MapServerConfigurationInvalid("mapserver_directive_outside_map")
        parent = stack[-1]
        if parent.kind == "PROJECTION":
            name, values = "__VALUE__", tuple(tokens)
        else:
            name, values = keyword, tuple(tokens[1:])
        if name in _REJECTED_DIRECTIVES:
            raise MapServerConfigurationUnsafe(name)
        if name in _DETACHED_DIRECTIVES:
            removed.append(name)
            losses.append(_loss("governed_binding_required", name, _path(stack), line_number))
            continue
        if not values:
            raise MapServerConfigurationInvalid("mapserver_directive_value_missing")
        supported = _SUPPORTED_DIRECTIVES.get(parent.kind, set())
        if parent.kind not in _SUPPORTED_BLOCKS or name not in supported:
            losses.append(_loss("unsupported_directive", name, _path(stack), line_number))
            continue
        if name == "EXPRESSION" and not _literal_expression(values):
            losses.append(_loss("unsupported_expression", name, _path(stack), line_number))
            continue
        parent.directives.append(_Directive(name, values, line_number))
    if stack or len(roots) != 1 or roots[0].kind != "MAP":
        raise MapServerConfigurationInvalid("mapserver_map_unbalanced")
    return roots[0], losses, removed


def _compile_style(
    root: _Node,
    layer: _Node,
    classes: list[_Node],
    losses: list[dict[str, Any]],
) -> dict[str, Any]:
    layer_name = _one_identifier(layer, "NAME", "mapserver_layer_name_invalid")
    layer_type = _one(layer, "TYPE", "mapserver_layer_type_missing").upper()
    maplibre_type = {"LINE": "line", "POLYGON": "fill", "POINT": "circle"}.get(layer_type)
    if maplibre_type is None:
        raise MapServerConfigurationInvalid("mapserver_layer_type_unsupported")
    class_item = _optional_one(layer, "CLASSITEM")
    label_item = _optional_one(layer, "LABELITEM")
    if class_item is not None and _IDENTIFIER.fullmatch(class_item) is None:
        raise MapServerConfigurationInvalid("mapserver_classitem_invalid")
    if label_item is not None and _IDENTIFIER.fullmatch(label_item) is None:
        raise MapServerConfigurationInvalid("mapserver_labelitem_invalid")

    colors: list[tuple[str, str]] = []
    widths: list[float] = []
    opacities: list[float] = []
    outlines: list[str] = []
    label_nodes: list[_Node] = []
    preserved = ["MAP", "LAYER.NAME", "LAYER.TYPE"]
    for index, class_node in enumerate(classes, 1):
        style_nodes = class_node.children_of("STYLE")
        if not style_nodes:
            raise MapServerConfigurationInvalid("mapserver_class_style_missing")
        if len(style_nodes) > 1:
            losses.append(
                _loss(
                    "additional_style_omitted",
                    "STYLE",
                    f"MAP/LAYER/CLASS[{index}]",
                    class_node.line,
                )
            )
        style_node = style_nodes[0]
        expression = _optional_one(class_node, "EXPRESSION")
        class_name = _optional_one(class_node, "NAME") or expression or f"class-{index}"
        color = _color(style_node, "COLOR", _default_color(maplibre_type))
        colors.append((expression or class_name, color))
        widths.append(
            _optional_number(style_node, "WIDTH") or (2.0 if maplibre_type == "line" else 1.0)
        )
        opacities.append((_optional_number(style_node, "OPACITY") or 100.0) / 100.0)
        outlines.append(_color(style_node, "OUTLINECOLOR", "#173f35"))
        label_nodes.extend(class_node.children_of("LABEL")[:1])
        preserved.extend([f"CLASS[{index}].STYLE.COLOR", f"CLASS[{index}].NAME"])

    if len(set(widths)) > 1:
        losses.append(
            _loss("per_class_width_collapsed", "WIDTH", "MAP/LAYER/CLASS/STYLE", layer.line)
        )
    if len(set(opacities)) > 1:
        losses.append(
            _loss(
                "per_class_opacity_collapsed",
                "OPACITY",
                "MAP/LAYER/CLASS/STYLE",
                layer.line,
            )
        )
    if len(set(outlines)) > 1:
        losses.append(
            _loss(
                "per_class_outline_collapsed",
                "OUTLINECOLOR",
                "MAP/LAYER/CLASS/STYLE",
                layer.line,
            )
        )

    paint: dict[str, Any]
    color_value: object = colors[0][1]
    if len(colors) > 1:
        if class_item is None or any(
            class_node.values("EXPRESSION") is None for class_node in classes
        ):
            losses.append(_loss("classification_collapsed", "CLASSITEM", "MAP/LAYER", layer.line))
        else:
            match: list[object] = ["match", ["get", class_item]]
            for value, color in colors:
                match.extend([value, color])
            match.append(colors[0][1])
            color_value = match
            preserved.extend(["LAYER.CLASSITEM", "CLASS.EXPRESSION"])
    if maplibre_type == "line":
        paint = {"line-color": color_value, "line-width": widths[0], "line-opacity": opacities[0]}
    elif maplibre_type == "fill":
        paint = {
            "fill-color": color_value,
            "fill-outline-color": outlines[0],
            "fill-opacity": opacities[0],
        }
    else:
        size = _optional_number(classes[0].children_of("STYLE")[0], "SIZE") or 8.0
        paint = {
            "circle-color": color_value,
            "circle-radius": max(1.0, min(32.0, size / 2.0)),
            "circle-opacity": opacities[0],
            "circle-stroke-color": outlines[0],
            "circle-stroke-width": widths[0],
        }
    identifier = _slug(layer_name)
    layers: list[dict[str, Any]] = [
        {"id": f"mapserver-{identifier}", "type": maplibre_type, "paint": paint}
    ]
    if label_item is not None and label_nodes:
        label = label_nodes[0]
        layers.append(
            {
                "id": f"mapserver-{identifier}-labels",
                "type": "symbol",
                "layout": {
                    "text-field": ["get", label_item],
                    "text-size": _label_size(_optional_one(label, "SIZE")),
                },
                "paint": {
                    "text-color": _color(label, "COLOR", "#172824"),
                    "text-halo-color": _color(label, "OUTLINECOLOR", "#ffffff"),
                    "text-halo-width": _optional_number(label, "OUTLINEWIDTH") or 1.0,
                },
            }
        )
        preserved.extend(["LAYER.LABELITEM", "CLASS.LABEL"])
    elif label_item is not None:
        losses.append(_loss("label_style_missing", "LABEL", "MAP/LAYER/CLASS", layer.line))
    elif label_nodes:
        losses.append(_loss("label_field_missing", "LABELITEM", "MAP/LAYER", layer.line))
    return {"version": 8, "sources": {}, "layers": layers, "_preserved": preserved}


def _canonical_mapfile(root: _Node, selected: _Node) -> str:
    lines = ["MAP"]
    _emit_directives(lines, root, 1)
    for child in root.children:
        if child is selected or child.kind == "LAYER" or child.kind not in _SUPPORTED_BLOCKS:
            continue
        _emit_node(lines, child, 1)
    _emit_node(lines, selected, 1)
    lines.append("END")
    return "\n".join(lines) + "\n"


def _emit_node(lines: list[str], node: _Node, depth: int) -> None:
    indent = "  " * depth
    lines.append(f"{indent}{node.kind}")
    _emit_directives(lines, node, depth + 1)
    for child in node.children:
        if child.kind in _SUPPORTED_BLOCKS:
            _emit_node(lines, child, depth + 1)
    lines.append(f"{indent}END")


def _emit_directives(lines: list[str], node: _Node, depth: int) -> None:
    indent = "  " * depth
    for directive in node.directives:
        values = " ".join(_quote(value) for value in directive.values)
        if directive.name == "__VALUE__":
            lines.append(f"{indent}{values}")
        else:
            lines.append(f"{indent}{directive.name} {values}")


def _select_layer(layers: list[_Node], layer_name: str | None) -> _Node:
    if layer_name is None:
        if len(layers) != 1:
            raise MapServerConfigurationInvalid("mapserver_layer_selection_required")
        return layers[0]
    if _IDENTIFIER.fullmatch(layer_name) is None:
        raise MapServerConfigurationInvalid("mapserver_layer_selection_invalid")
    matches = [layer for layer in layers if _optional_one(layer, "NAME") == layer_name]
    if len(matches) != 1:
        raise MapServerConfigurationInvalid("mapserver_layer_not_found")
    return matches[0]


def _strip_comment(line: str) -> str:
    quoted = False
    escaped = False
    for index, character in enumerate(line):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quoted:
            escaped = True
            continue
        if character == '"':
            quoted = not quoted
        elif character == "#" and not quoted:
            return line[:index]
    if quoted:
        raise MapServerConfigurationInvalid("mapserver_quote_unbalanced")
    return line


def _split(line: str) -> list[str]:
    try:
        lexer = shlex.shlex(line, posix=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError as error:
        raise MapServerConfigurationInvalid("mapserver_token_invalid") from error
    if len(tokens) > 32 or any(len(token.encode("utf-8")) > 500 for token in tokens):
        raise MapServerConfigurationInvalid("mapserver_token_limit")
    return tokens


def _path(stack: list[_Node]) -> str:
    return "/".join(node.kind for node in stack)


def _loss(code: str, directive: str, path: str, line: int) -> dict[str, Any]:
    return {"code": code, "directive": directive, "path": path, "line": line}


def _literal_expression(values: tuple[str, ...]) -> bool:
    return len(values) == 1 and not any(marker in values[0] for marker in "[]()/${}")


def _one(node: _Node, name: str, code: str) -> str:
    values = node.values(name)
    if values is None or len(values) != 1:
        raise MapServerConfigurationInvalid(code)
    return values[0]


def _one_identifier(node: _Node, name: str, code: str) -> str:
    value = _one(node, name, code)
    if _IDENTIFIER.fullmatch(value) is None:
        raise MapServerConfigurationInvalid(code)
    return value


def _optional_one(node: _Node, name: str) -> str | None:
    values = node.values(name)
    if values is None:
        return None
    if len(values) != 1:
        raise MapServerConfigurationInvalid(f"mapserver_{name.casefold()}_invalid")
    return values[0]


def _optional_number(node: _Node, name: str) -> float | None:
    value = _optional_one(node, name)
    if value is None:
        return None
    try:
        number = float(value)
    except ValueError as error:
        raise MapServerConfigurationInvalid(f"mapserver_{name.casefold()}_invalid") from error
    if not math.isfinite(number) or number < 0 or number > 1_000_000_000:
        raise MapServerConfigurationInvalid(f"mapserver_{name.casefold()}_invalid")
    return number


def _color(node: _Node, name: str, default: str) -> str:
    values = node.values(name)
    if values is None:
        return default
    if len(values) != 3:
        raise MapServerConfigurationInvalid(f"mapserver_{name.casefold()}_invalid")
    try:
        channels = [int(value) for value in values]
    except ValueError as error:
        raise MapServerConfigurationInvalid(f"mapserver_{name.casefold()}_invalid") from error
    if any(channel < 0 or channel > 255 for channel in channels):
        raise MapServerConfigurationInvalid(f"mapserver_{name.casefold()}_invalid")
    return "#" + "".join(f"{channel:02x}" for channel in channels)


def _default_color(layer_type: str) -> str:
    return {"line": "#275d52", "fill": "#4d927f", "circle": "#2f7d68"}[layer_type]


def _label_size(value: str | None) -> float:
    if value is None:
        return 12.0
    named = {"TINY": 6.0, "SMALL": 8.0, "MEDIUM": 12.0, "LARGE": 16.0, "GIANT": 24.0}
    if value.upper() in named:
        return named[value.upper()]
    try:
        number = float(value)
    except ValueError as error:
        raise MapServerConfigurationInvalid("mapserver_label_size_invalid") from error
    if not math.isfinite(number) or not 6 <= number <= 32:
        raise MapServerConfigurationInvalid("mapserver_label_size_invalid")
    return number


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug[:80] or "layer"


def _quote(value: str) -> str:
    if re.fullmatch(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)", value):
        return value
    if value.upper() in {
        "ON",
        "OFF",
        "DEFAULT",
        "TRUE",
        "FALSE",
        "LINE",
        "POLYGON",
        "POINT",
        "DD",
        "METERS",
        "FEET",
        "MILES",
        "KILOMETERS",
        "RGB",
        "RGBA",
        "BITMAP",
        "AUTO",
        "EMBED",
        "UL",
        "UC",
        "UR",
        "LL",
        "LC",
        "LR",
    }:
        return value.upper()
    return json.dumps(value, ensure_ascii=False)


def _main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert a bounded MapServer Mapfile without executing source directives."
    )
    parser.add_argument("mapfile", type=Path)
    parser.add_argument("--layer")
    parser.add_argument("--mapscript", type=Path)
    arguments = parser.parse_args()
    mapfile = arguments.mapfile.read_text(encoding="utf-8")
    mapscript = (
        arguments.mapscript.read_text(encoding="utf-8") if arguments.mapscript is not None else None
    )
    converted = convert_mapserver_configuration(
        mapfile,
        layer_name=arguments.layer,
        mapscript=mapscript,
    )
    print(
        json.dumps(
            {
                "result": "pass",
                "style_definition_sha256": sha256(
                    converted.style_definition.encode("utf-8")
                ).hexdigest(),
                "canonical_mapfile_sha256": sha256(
                    converted.canonical_mapfile.encode("utf-8")
                ).hexdigest(),
                "geometry_layer_id": converted.geometry_layer_id,
                "label_layer_id": converted.label_layer_id,
                "report": converted.report,
                "request_limits": converted.request_limits,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
