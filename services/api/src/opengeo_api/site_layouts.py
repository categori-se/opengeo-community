import re
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from opengeo_api.json_canonical import canonical_json_bytes

PRINT_LAYOUT_SCHEMA = "opengeo.print-layout.1.1.0"
LEGACY_PRINT_LAYOUT_SCHEMA = "opengeo.print-layout.1.0.0"
MAX_LAYOUT_PAGES = 64
MAX_LAYOUT_ELEMENTS_PER_PAGE = 32
MAX_LAYOUT_ELEMENTS = 256
MAX_LAYOUT_MAPS = 16
MAX_LAYOUT_BYTES = 32_768

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_PAGE_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$")
_LEGACY_COMMON_KEYS = frozenset({"id", "type", "x", "y", "width", "height"})
_COMMON_KEYS = _LEGACY_COMMON_KEYS | {"rotation", "clip"}
_LEGACY_ELEMENT_KEYS = {
    "map_frame": _LEGACY_COMMON_KEYS | {"resourceId"},
    "text": _LEGACY_COMMON_KEYS | {"text", "style"},
    "source_panel": _LEGACY_COMMON_KEYS | {"mapFrameId"},
    "north_arrow": _LEGACY_COMMON_KEYS | {"mapFrameId"},
    "scale_bar": _LEGACY_COMMON_KEYS | {"mapFrameId"},
}
_ELEMENT_KEYS = {
    "map_frame": _COMMON_KEYS | {"resourceId", "fit"},
    "text": _COMMON_KEYS | {"text", "style"},
    "source_panel": _COMMON_KEYS | {"mapFrameId"},
    "north_arrow": _COMMON_KEYS | {"mapFrameId"},
    "scale_bar": _COMMON_KEYS | {"mapFrameId"},
    "legend_frame": _COMMON_KEYS | {"mapFrameId"},
    "image_frame": _COMMON_KEYS | {"blockId", "fit"},
    "table_frame": _COMMON_KEYS | {"blockId"},
    "chart_frame": _COMMON_KEYS | {"blockId"},
}
_TEXT_STYLES = frozenset({"title", "heading", "body", "note", "attribution"})
_IMAGE_FITS = frozenset({"contain", "cover"})


class SiteLayoutError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PrintLayoutElement:
    element_id: str
    type: Literal[
        "map_frame",
        "text",
        "source_panel",
        "north_arrow",
        "scale_bar",
        "legend_frame",
        "image_frame",
        "table_frame",
        "chart_frame",
    ]
    x: int
    y: int
    width: int
    height: int
    resource_id: UUID | None = None
    text: str | None = None
    style: str | None = None
    map_frame_id: str | None = None
    block_id: str | None = None
    fit: str | None = None
    rotation: int = 0
    clip: bool = True

    def as_json(self, schema_version: str = PRINT_LAYOUT_SCHEMA) -> dict[str, object]:
        value: dict[str, object] = {
            "id": self.element_id,
            "type": self.type,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }
        if schema_version == PRINT_LAYOUT_SCHEMA:
            value["rotation"] = self.rotation
            value["clip"] = self.clip
        if self.resource_id is not None:
            value["resourceId"] = str(self.resource_id)
        if self.text is not None:
            value["text"] = self.text
        if self.style is not None:
            value["style"] = self.style
        if self.map_frame_id is not None:
            value["mapFrameId"] = self.map_frame_id
        if self.block_id is not None:
            value["blockId"] = self.block_id
        if self.fit is not None:
            value["fit"] = self.fit
        return value


@dataclass(frozen=True, slots=True)
class PrintLayoutPage:
    site_page_slug: str
    elements: tuple[PrintLayoutElement, ...]

    def as_json(self, schema_version: str = PRINT_LAYOUT_SCHEMA) -> dict[str, object]:
        return {
            "sitePageSlug": self.site_page_slug,
            "elements": [element.as_json(schema_version) for element in self.elements],
        }


@dataclass(frozen=True, slots=True)
class PrintLayoutDocument:
    pages: tuple[PrintLayoutPage, ...]
    schema_version: str = PRINT_LAYOUT_SCHEMA

    def as_json(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "pages": [page.as_json(self.schema_version) for page in self.pages],
        }


def empty_print_layout() -> dict[str, object]:
    return {"schemaVersion": PRINT_LAYOUT_SCHEMA, "pages": []}


def parse_print_layout(value: object) -> PrintLayoutDocument:
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "pages"}:
        raise SiteLayoutError("site_print_layout_shape_invalid")
    schema_version = value.get("schemaVersion")
    if schema_version not in {LEGACY_PRINT_LAYOUT_SCHEMA, PRINT_LAYOUT_SCHEMA}:
        raise SiteLayoutError("site_print_layout_schema_unsupported")
    raw_pages = value.get("pages")
    if not isinstance(raw_pages, list) or len(raw_pages) > MAX_LAYOUT_PAGES:
        raise SiteLayoutError("site_print_layout_pages_invalid")
    pages: list[PrintLayoutPage] = []
    page_slugs: set[str] = set()
    map_resources: set[UUID] = set()
    element_total = 0
    for raw_page in raw_pages:
        page = _parse_page(raw_page, cast(str, schema_version))
        if page.site_page_slug in page_slugs:
            raise SiteLayoutError("site_print_layout_page_duplicate")
        page_slugs.add(page.site_page_slug)
        element_total += len(page.elements)
        if element_total > MAX_LAYOUT_ELEMENTS:
            raise SiteLayoutError("site_print_layout_element_limit_exceeded")
        map_resources.update(
            element.resource_id for element in page.elements if element.resource_id is not None
        )
        if len(map_resources) > MAX_LAYOUT_MAPS:
            raise SiteLayoutError("site_print_layout_map_limit_exceeded")
        pages.append(page)
    document = PrintLayoutDocument(tuple(pages), cast(str, schema_version))
    if len(canonical_json_bytes(document.as_json())) > MAX_LAYOUT_BYTES:
        raise SiteLayoutError("site_print_layout_size_exceeded")
    return document


def print_layout_resource_ids(value: object) -> frozenset[UUID]:
    return frozenset(
        element.resource_id
        for page in parse_print_layout(value).pages
        for element in page.elements
        if element.resource_id is not None
    )


def _parse_page(value: object, schema_version: str) -> PrintLayoutPage:
    if not isinstance(value, dict) or set(value) != {"sitePageSlug", "elements"}:
        raise SiteLayoutError("site_print_layout_page_shape_invalid")
    slug = value.get("sitePageSlug")
    raw_elements = value.get("elements")
    if not isinstance(slug, str) or _PAGE_SLUG.fullmatch(slug) is None:
        raise SiteLayoutError("site_print_layout_page_slug_invalid")
    if (
        not isinstance(raw_elements, list)
        or not 1 <= len(raw_elements) <= MAX_LAYOUT_ELEMENTS_PER_PAGE
    ):
        raise SiteLayoutError("site_print_layout_page_elements_invalid")
    elements = tuple(_parse_element(raw, schema_version) for raw in raw_elements)
    identifiers = {element.element_id for element in elements}
    if len(identifiers) != len(elements):
        raise SiteLayoutError("site_print_layout_element_duplicate")
    map_identifiers = {element.element_id for element in elements if element.type == "map_frame"}
    for element in elements:
        if element.map_frame_id is not None and element.map_frame_id not in map_identifiers:
            raise SiteLayoutError("site_print_layout_map_frame_not_found")
    return PrintLayoutPage(site_page_slug=slug, elements=elements)


def _parse_element(value: object, schema_version: str) -> PrintLayoutElement:
    if not isinstance(value, dict):
        raise SiteLayoutError("site_print_layout_element_shape_invalid")
    kind = value.get("type")
    element_keys = (
        _LEGACY_ELEMENT_KEYS if schema_version == LEGACY_PRINT_LAYOUT_SCHEMA else _ELEMENT_KEYS
    )
    if not isinstance(kind, str) or kind not in element_keys:
        raise SiteLayoutError("site_print_layout_element_type_invalid")
    if set(value) != element_keys[kind]:
        raise SiteLayoutError("site_print_layout_element_shape_invalid")
    identifier = value.get("id")
    if not isinstance(identifier, str) or _IDENTIFIER.fullmatch(identifier) is None:
        raise SiteLayoutError("site_print_layout_element_id_invalid")
    coordinates = tuple(
        _coordinate(value.get(name), name) for name in ("x", "y", "width", "height")
    )
    x, y, width, height = coordinates
    if x + width > 1000 or y + height > 1000:
        raise SiteLayoutError("site_print_layout_element_out_of_bounds")
    element_type = cast(
        Literal[
            "map_frame",
            "text",
            "source_panel",
            "north_arrow",
            "scale_bar",
            "legend_frame",
            "image_frame",
            "table_frame",
            "chart_frame",
        ],
        kind,
    )
    rotation = 0
    clip = True
    if schema_version == PRINT_LAYOUT_SCHEMA:
        rotation_value = value.get("rotation")
        clip_value = value.get("clip")
        if (
            isinstance(rotation_value, bool)
            or not isinstance(rotation_value, int)
            or not -180 <= rotation_value <= 180
        ):
            raise SiteLayoutError("site_print_layout_rotation_invalid")
        if not isinstance(clip_value, bool):
            raise SiteLayoutError("site_print_layout_clip_invalid")
        rotation = rotation_value
        clip = clip_value
    if kind == "map_frame":
        try:
            resource_id = UUID(cast(str, value.get("resourceId")))
        except (TypeError, ValueError) as error:
            raise SiteLayoutError("site_print_layout_resource_id_invalid") from error
        fit = value.get("fit", "contain")
        if not isinstance(fit, str) or fit not in _IMAGE_FITS:
            raise SiteLayoutError("site_print_layout_fit_invalid")
        return PrintLayoutElement(
            identifier,
            element_type,
            x,
            y,
            width,
            height,
            resource_id=resource_id,
            fit=fit if schema_version == PRINT_LAYOUT_SCHEMA else None,
            rotation=rotation,
            clip=clip,
        )
    if kind == "text":
        content = value.get("text")
        style = value.get("style")
        if (
            not isinstance(content, str)
            or content != content.strip()
            or not 1 <= len(content) <= 1_000
        ):
            raise SiteLayoutError("site_print_layout_text_invalid")
        if not isinstance(style, str) or style not in _TEXT_STYLES:
            raise SiteLayoutError("site_print_layout_text_style_invalid")
        return PrintLayoutElement(
            identifier,
            element_type,
            x,
            y,
            width,
            height,
            text=content,
            style=style,
            rotation=rotation,
            clip=clip,
        )
    if kind in {"image_frame", "table_frame", "chart_frame"}:
        block_id = value.get("blockId")
        if not isinstance(block_id, str) or _IDENTIFIER.fullmatch(block_id) is None:
            raise SiteLayoutError("site_print_layout_block_id_invalid")
        content_fit: str | None = None
        if kind == "image_frame":
            raw_fit = value.get("fit")
            if not isinstance(raw_fit, str) or raw_fit not in _IMAGE_FITS:
                raise SiteLayoutError("site_print_layout_fit_invalid")
            content_fit = raw_fit
        return PrintLayoutElement(
            identifier,
            element_type,
            x,
            y,
            width,
            height,
            block_id=block_id,
            fit=content_fit,
            rotation=rotation,
            clip=clip,
        )
    map_frame_id = value.get("mapFrameId")
    if not isinstance(map_frame_id, str) or _IDENTIFIER.fullmatch(map_frame_id) is None:
        raise SiteLayoutError("site_print_layout_map_frame_id_invalid")
    return PrintLayoutElement(
        identifier,
        element_type,
        x,
        y,
        width,
        height,
        map_frame_id=map_frame_id,
        rotation=rotation,
        clip=clip,
    )


def _coordinate(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise SiteLayoutError(f"site_print_layout_{name}_invalid")
    minimum = 0 if name in {"x", "y"} else 10
    if not minimum <= value <= 1000:
        raise SiteLayoutError(f"site_print_layout_{name}_invalid")
    return value
