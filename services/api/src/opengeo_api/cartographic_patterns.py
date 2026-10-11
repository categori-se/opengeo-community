"""Read only exact Studio-generated graphic fills; never accept arbitrary SVG."""

import base64
import json
import math
import re
from typing import Any
from xml.etree import ElementTree as ET

PATHS = {
    "hatch": "M-8 8L8-8 M0 32L32 0 M24 40L40 24",
    "dots": "M8 8h.1 M24 24h.1",
    "waves": "M-8 8Q0 24 8 8T24 8T40 8 M-8 24Q0 40 8 24T24 24T40 24",
    "ripples": "M2 8h12 M18 24h12",
    "forest": "M8 3l-5 9h10z M8 12v5 M24 18l-5 9h10z M24 27v4",
    "grass": "M4 18l4 6 4-9 M8 24v4 M20 2l4 6 4-5 M24 8v4",
    "wetland": "M2 23h12 M18 10h12 M8 22V12m0 5l-4-4m4 6l4-5 M24 9V1",
}


def _escape(value: str) -> str:
    for key, replacement in [
        ("&", "&amp;"),
        ("<", "&lt;"),
        (">", "&gt;"),
        ('"', "&quot;"),
        ("'", "&apos;"),
    ]:
        value = value.replace(key, replacement)
    return value


def generated_pattern(definition: str) -> dict[str, Any]:
    if len(definition.encode()) > 49152 or "<!" in definition:
        raise ValueError("Unsupported pattern definition")
    try:
        root = ET.fromstring(definition)
    except ET.ParseError as error:
        raise ValueError("Invalid pattern XML") from error
    title = root.find(".//{http://www.opengis.net/se}Title")
    abstract = root.find(".//{http://www.opengis.net/se}Abstract")
    if title is None or abstract is None or not abstract.text:
        raise ValueError("Missing pattern recipe")
    prefix = "OpenGeo procedural pattern v1 "
    if not abstract.text.startswith(prefix):
        raise ValueError("Unknown pattern recipe")
    recipe = json.loads(abstract.text[len(prefix) :])
    if not isinstance(recipe, dict) or set(recipe) != {
        "id",
        "foreground",
        "background",
        "size",
        "width",
        "transparent",
    }:
        raise ValueError("Invalid pattern recipe")
    if (
        not isinstance(recipe["id"], str)
        or recipe["id"] not in PATHS
        or type(recipe["transparent"]) is not bool
    ):
        raise ValueError("Invalid pattern motif")
    for key in ("foreground", "background"):
        if not isinstance(recipe[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", recipe[key]):
            raise ValueError("Invalid pattern color")
    for key, minimum, maximum in [("size", 16, 64), ("width", 0.5, 4)]:
        if (
            type(recipe[key]) not in (int, float)
            or not math.isfinite(recipe[key])
            or not minimum <= recipe[key] <= maximum
        ):
            raise ValueError("Invalid pattern dimension")
    size, width = str(recipe["size"]), str(recipe["width"])
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        'viewBox="0 0 32 32">'
        f'<rect width="32" height="32" fill="{recipe["background"]}" '
        f'fill-opacity="{0 if recipe["transparent"] else 1}"/>'
        f'<path d="{PATHS[recipe["id"]]}" stroke="{recipe["foreground"]}" '
        f'stroke-width="{width}" stroke-linecap="round" fill="none"/></svg>'
    )
    encoded = base64.b64encode(svg.encode()).decode()
    name = _escape(title.text or "")
    expected = (
        '<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" '
        'xmlns:se="http://www.opengis.net/se" version="1.1.0">'
        "<NamedLayer><se:Name>features</se:Name><UserStyle>"
        f"<se:Name>{name}</se:Name><se:Description><se:Title>{name}</se:Title>"
        f"<se:Abstract>{_escape(abstract.text)}</se:Abstract></se:Description>"
        "<se:FeatureTypeStyle><se:Rule><se:PolygonSymbolizer><se:Fill>"
        "<se:GraphicFill><se:Graphic><se:ExternalGraphic>"
        f'<se:InlineContent encoding="base64">{encoded}</se:InlineContent>'
        "<se:Format>image/svg+xml</se:Format></se:ExternalGraphic>"
        f"<se:Size>{size}</se:Size></se:Graphic></se:GraphicFill></se:Fill>"
        "</se:PolygonSymbolizer></se:Rule></se:FeatureTypeStyle>"
        "</UserStyle></NamedLayer></StyledLayerDescriptor>"
    )
    if expected != definition:
        raise ValueError("Pattern differs from generated definition")
    return {"svg": svg, "size": recipe["size"]}
