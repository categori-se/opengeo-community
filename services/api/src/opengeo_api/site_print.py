import base64
import math
import re
import struct
import textwrap
import zlib
from collections.abc import Callable
from dataclasses import dataclass
from html import escape
from itertools import pairwise
from typing import cast
from uuid import UUID

from opengeo_api.print_fonts import BitmapGlyph, PrintFontError, configured_unifont
from opengeo_api.print_text import (
    PrintTextError,
    PrintTextLayout,
    layout_print_text,
    print_text_clusters,
)
from opengeo_api.site_layouts import (
    PrintLayoutElement,
    PrintLayoutPage,
    SiteLayoutError,
    parse_print_layout,
)
from opengeo_api.site_publications import (
    PublishedMapLegend,
    PublishedResourceReference,
    PublishedSite,
    SitePage,
)

MAX_PRINT_PIXELS = 20_000_000
MAX_PRINT_UNIQUE_GLYPHS = 1024
MAX_PRINT_COMPOSITE_BITMAPS = 16_384
PRINT_RASTER_DPI = 96
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PAGE_POINTS = {
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
    "tabloid": (792.0, 1224.0),
    "a4": (595.0, 842.0),
    "a3": (842.0, 1191.0),
    "a2": (1191.0, 1684.0),
    "a1": (1684.0, 2384.0),
    "a0": (2384.0, 3370.0),
}
_BOOLEAN_OPTIONS = {"true": True, "false": False}


class SitePrintError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class PrintOptions:
    page_size: str
    orientation: str
    layout: str
    legend: bool
    north_arrow: bool
    scale_bar: bool

    @property
    def page_points(self) -> tuple[float, float]:
        portrait = _PAGE_POINTS[self.page_size]
        return portrait if self.orientation == "portrait" else (portrait[1], portrait[0])


@dataclass(frozen=True, slots=True)
class _PdfImage:
    width: int
    height: int
    rgb: bytes


@dataclass(frozen=True, slots=True)
class _PrintPage:
    title: str
    lines: tuple[str, ...]
    image: _PdfImage | None = None
    reference: PublishedResourceReference | None = None
    layout_page: PrintLayoutPage | None = None


@dataclass(frozen=True, slots=True)
class _PdfGlyph:
    unicode_text: str
    bitmaps: tuple[BitmapGlyph, ...]

    @property
    def advance(self) -> float:
        return sum(0.5 if bitmap.width == 8 else 1.0 for bitmap in self.bitmaps)


class _PdfFontCatalog:
    def __init__(self) -> None:
        try:
            self._unifont = configured_unifont()
        except PrintFontError as error:
            raise SitePrintError(str(error)) from error
        self._locations: dict[tuple[str, str], tuple[int, int]] = {}
        self.banks: list[list[_PdfGlyph]] = []
        self._composite_bitmaps = 0

    def encode_layout(self, layout: PrintTextLayout) -> tuple[tuple[int, bytes], ...]:
        if layout.contains_rtl:
            bank, code = self._location(layout.logical, layout.visual)
            return ((bank, bytes((code,))),)
        runs: list[tuple[int, bytearray]] = []
        for character in layout.visual:
            bank, code = self._location(character, character)
            if not runs or runs[-1][0] != bank:
                runs.append((bank, bytearray()))
            runs[-1][1].append(code)
        return tuple((bank, bytes(encoded)) for bank, encoded in runs)

    def advance(self, character: str) -> float:
        return 0.5 if self._glyph(character).width == 8 else 1.0

    def layout(self, value: str) -> PrintTextLayout:
        return _print_text_layout(value)

    def text_advance(self, value: str) -> float:
        return sum(self.advance(character) for character in self.layout(value).visual)

    def _location(self, unicode_text: str, visual: str) -> tuple[int, int]:
        key = (unicode_text, visual)
        existing = self._locations.get(key)
        if existing is not None:
            return existing
        if len(self._locations) >= MAX_PRINT_UNIQUE_GLYPHS:
            raise SitePrintError("site_print_unicode_glyph_limit_exceeded")
        bitmaps = tuple(self._glyph(character) for character in visual)
        if not bitmaps:
            raise SitePrintError("site_print_unicode_font_empty")
        self._composite_bitmaps += len(bitmaps)
        if self._composite_bitmaps > MAX_PRINT_COMPOSITE_BITMAPS:
            raise SitePrintError("site_print_composite_bitmap_limit_exceeded")
        if not self.banks or len(self.banks[-1]) == 255:
            self.banks.append([])
        bank = len(self.banks) - 1
        code = len(self.banks[bank]) + 1
        self.banks[bank].append(_PdfGlyph(unicode_text=unicode_text, bitmaps=bitmaps))
        location = (bank, code)
        self._locations[key] = location
        return location

    def _glyph(self, character: str) -> BitmapGlyph:
        glyph = self._unifont.get(ord(character)) if self._unifont is not None else None
        return glyph or _fallback_bitmap(character)


@dataclass(frozen=True, slots=True)
class _MapLayout:
    map_x: float
    map_y: float
    map_width: float
    map_height: float
    panel_x: float | None
    panel_y: float
    panel_width: float
    panel_height: float


def resolve_print_options(publication: PublishedSite) -> PrintOptions:
    """Resolve the bounded print contract stored in an immutable site version."""

    values = publication.site.theme_options
    page_size = _enum_option(values, "printPageSize", set(_PAGE_POINTS), "a4")
    orientation = _enum_option(values, "printOrientation", {"portrait", "landscape"}, "landscape")
    layout = _enum_option(values, "printLayout", {"flow", "map-sheet"}, "flow")
    return PrintOptions(
        page_size=page_size,
        orientation=orientation,
        layout=layout,
        legend=_boolean_option(values, "printLegend", True),
        north_arrow=_boolean_option(values, "printNorthArrow", True),
        scale_bar=_boolean_option(values, "printScaleBar", True),
    )


def build_print_pdf(
    publication: PublishedSite,
    map_images: dict[UUID, bytes],
    site_assets: dict[UUID, bytes] | None = None,
) -> bytes:
    """Build a deterministic, dependency-free PDF from one sealed site edition."""

    options = resolve_print_options(publication)
    decoded = _decoded_map_images(publication, map_images)
    decoded_assets = _decoded_site_assets(publication, site_assets or {}, decoded)
    try:
        layout = parse_print_layout(publication.site.print_layout)
    except SiteLayoutError as error:
        raise SitePrintError(str(error)) from error
    layout_by_slug = {page.site_page_slug: page for page in layout.pages}
    pages = [
        (
            _PrintPage(title=page.resource_title, lines=(), layout_page=layout_by_slug[page.slug])
            if page.slug in layout_by_slug
            else _content_page(publication, page, options)
        )
        for page in publication.site.pages
    ]
    placed_resource_ids = {
        element.resource_id
        for layout_page in layout.pages
        for element in layout_page.elements
        if element.resource_id is not None
    }
    for reference in publication.references:
        appendix_image = decoded.get(reference.resource_id)
        if appendix_image is not None and reference.resource_id not in placed_resource_ids:
            pages.append(_map_page(reference, appendix_image))
    if not pages:
        raise SitePrintError("site_has_no_printable_pages")
    return _pdf(publication, pages, options, decoded, decoded_assets)


def build_print_page_png(
    publication: PublishedSite,
    page_slug: str,
    map_images: dict[UUID, bytes],
    site_assets: dict[UUID, bytes] | None = None,
) -> bytes:
    """Build one deterministic 96-DPI whole-page PNG from an immutable edition."""

    page = next(
        (candidate for candidate in publication.site.pages if candidate.slug == page_slug), None
    )
    if page is None:
        raise SitePrintError("site_print_page_not_found")
    options = resolve_print_options(publication)
    decoded = _decoded_map_images(publication, map_images)
    decoded_assets = _decoded_site_assets(publication, site_assets or {}, decoded)
    try:
        layout = parse_print_layout(publication.site.print_layout)
    except SiteLayoutError as error:
        raise SitePrintError(str(error)) from error
    layout_page = next(
        (candidate for candidate in layout.pages if candidate.site_page_slug == page_slug), None
    )
    page_width, page_height = _raster_dimensions(options)
    canvas = bytearray(b"\xff" * (page_width * page_height * 3))
    if layout_page is None:
        _raster_flow_page(
            canvas,
            page_width,
            page_height,
            publication,
            _content_page(publication, page, options),
        )
    else:
        _raster_positioned_page(
            canvas,
            page_width,
            page_height,
            publication,
            layout_page,
            decoded,
            decoded_assets,
        )
    _raster_footer(canvas, page_width, page_height, publication, page_slug, options)
    return _encode_png(
        page_width,
        page_height,
        bytes(canvas),
        description=(
            f"OpenGeo edition {publication.edition.edition_id}; page {page_slug}; "
            f"title {page.resource_title}; "
            f"manifest SHA-256 {publication.edition.manifest_checksum_sha256}"
        ),
    )


def build_map_sheet_svg(
    publication: PublishedSite,
    reference: PublishedResourceReference,
    body: bytes,
) -> bytes:
    """Build one deterministic, self-contained, printable SVG map sheet."""

    sealed_reference = next(
        (
            candidate
            for candidate in publication.references
            if candidate.resource_id == reference.resource_id
        ),
        None,
    )
    if sealed_reference != reference:
        raise SitePrintError("unsealed_site_snapshot")
    image = _sealed_image(reference, body)
    if image.width * image.height > MAX_PRINT_PIXELS:
        raise SitePrintError("site_print_pixel_budget_exceeded")
    options = resolve_print_options(publication)
    page_width, page_height = options.page_points
    layout = _map_layout(options, image)
    snapshot = reference.snapshot
    if snapshot is None:
        raise SitePrintError("unsealed_site_snapshot")
    image_top = page_height - layout.map_y - layout.map_height
    title = _truncate(reference.title, max(48, int((page_width - 72) / 8.5)))
    site_title = _truncate(publication.site.title, max(60, int((page_width - 72) / 6.5)))
    attribution = _map_attribution(reference)
    encoded = base64.b64encode(body).decode("ascii")
    elements = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{_number(page_width)}pt" '
            f'height="{_number(page_height)}pt" viewBox="0 0 {_number(page_width)} '
            f'{_number(page_height)}" role="img" aria-labelledby="sheet-title sheet-description">'
        ),
        f'<title id="sheet-title">{escape(reference.title)} — printable map sheet</title>',
        (
            '<desc id="sheet-description">A self-contained map sheet from sealed site edition '
            f"{publication.edition.edition_number}, with extent {escape(_extent(snapshot.bbox))} "
            f"in {escape(snapshot.crs)}.</desc>"
        ),
        (
            "<metadata>OpenGeo immutable edition "
            f"{publication.edition.edition_id}; map SHA-256 {snapshot.checksum_sha256}; "
            f"manifest SHA-256 {publication.edition.manifest_checksum_sha256}</metadata>"
        ),
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="36" y="40" class="title">{escape(title)}</text>',
        f'<text x="36" y="60" class="site">{escape(site_title)}</text>',
        (
            f'<image x="{layout.map_x:.3f}" y="{image_top:.3f}" '
            f'width="{layout.map_width:.3f}" height="{layout.map_height:.3f}" '
            f'preserveAspectRatio="none" href="data:image/png;base64,{encoded}"/>'
        ),
        (
            f'<rect x="{layout.map_x:.3f}" y="{image_top:.3f}" '
            f'width="{layout.map_width:.3f}" height="{layout.map_height:.3f}" '
            'fill="none" stroke="#172026" stroke-width="0.75"/>'
        ),
    ]
    if options.legend and layout.panel_x is not None:
        panel_top = page_height - layout.panel_y - layout.panel_height
        elements.extend(
            [
                (
                    f'<rect x="{layout.panel_x:.3f}" y="{panel_top:.3f}" '
                    f'width="{layout.panel_width:.3f}" height="{layout.panel_height:.3f}" '
                    'fill="#ffffff" stroke="#172026" stroke-width="0.75"/>'
                ),
                *_svg_legend(
                    snapshot.legend,
                    layout.panel_x + 10,
                    panel_top + 20,
                    layout.panel_width - 20,
                    layout.panel_height - 30,
                ),
            ]
        )
    if options.north_arrow:
        elements.extend(_svg_north_arrow(layout, page_height))
    if options.scale_bar:
        elements.extend(_svg_scale_bar(reference, layout, page_height))
    elements.extend(
        [
            (
                f'<text x="36" y="{page_height - 65:.3f}" class="detail">'
                f"{escape(_truncate(attribution, max(70, int((page_width - 72) / 5.2))))}</text>"
            ),
            (
                f'<text x="36" y="{page_height - 50:.3f}" class="checksum">'
                f"Map SHA-256 {snapshot.checksum_sha256}</text>"
            ),
            (
                f'<text x="36" y="{page_height - 22:.3f}" class="footer">Edition '
                f"{publication.edition.edition_number} · {_page_label(options)} · manifest "
                f"{publication.edition.manifest_checksum_sha256}</text>"
            ),
            (
                "<style>.title{font:700 19px Helvetica,Arial,sans-serif;fill:#172026}"
                ".site{font:9px Helvetica,Arial,sans-serif;fill:#43515a}"
                ".detail{font:8px Helvetica,Arial,sans-serif;fill:#172026}"
                ".checksum,.footer{font:6px ui-monospace,monospace;fill:#43515a}"
                ".legend-title{font:700 10px Helvetica,Arial,sans-serif;fill:#172026}"
                ".legend-line{font:8px Helvetica,Arial,sans-serif;fill:#172026}"
                ".furniture{font:700 9px Helvetica,Arial,sans-serif;fill:#172026}</style>"
            ),
            "</svg>",
        ]
    )
    return ("\n".join(elements) + "\n").encode("utf-8")


def _enum_option(values: dict[str, object], key: str, allowed: set[str], default: str) -> str:
    raw = values.get(key)
    if raw is None:
        return default
    if not isinstance(raw, str) or raw not in allowed:
        raise SitePrintError(f"site_print_option_{key}_invalid")
    return raw


def _boolean_option(values: dict[str, object], key: str, default: bool) -> bool:
    raw = values.get(key)
    if raw is None:
        return default
    if not isinstance(raw, str) or raw not in _BOOLEAN_OPTIONS:
        raise SitePrintError(f"site_print_option_{key}_invalid")
    return _BOOLEAN_OPTIONS[raw]


def _sealed_image(reference: PublishedResourceReference, body: bytes) -> _PdfImage:
    snapshot = reference.snapshot
    if snapshot is None:
        raise SitePrintError("unsealed_site_snapshot")
    if len(body) != snapshot.size_bytes or _sha256(body) != snapshot.checksum_sha256:
        raise SitePrintError("site_snapshot_checksum_mismatch")
    image = _decode_png(body)
    if (image.width, image.height) != (snapshot.width, snapshot.height):
        raise SitePrintError("site_snapshot_dimensions_changed")
    return image


def _decoded_map_images(
    publication: PublishedSite, map_images: dict[UUID, bytes]
) -> dict[UUID, _PdfImage]:
    references = {reference.resource_id: reference for reference in publication.references}
    decoded: dict[UUID, _PdfImage] = {}
    total_pixels = 0
    for resource_id, body in map_images.items():
        reference = references.get(resource_id)
        if reference is None:
            raise SitePrintError("unsealed_site_snapshot")
        image = _sealed_image(reference, body)
        total_pixels += image.width * image.height
        if total_pixels > MAX_PRINT_PIXELS:
            raise SitePrintError("site_print_pixel_budget_exceeded")
        decoded[resource_id] = image
    return decoded


def _decoded_site_assets(
    publication: PublishedSite,
    asset_images: dict[UUID, bytes],
    decoded_maps: dict[UUID, _PdfImage],
) -> dict[UUID, _PdfImage]:
    assets = {asset.object_id: asset for asset in publication.assets}
    decoded: dict[UUID, _PdfImage] = {}
    total_pixels = sum(image.width * image.height for image in decoded_maps.values())
    for object_id, body in asset_images.items():
        asset = assets.get(object_id)
        if (
            asset is None
            or asset.kind != "image"
            or asset.content_type != "image/png"
            or len(body) != asset.size_bytes
            or _sha256(body) != asset.checksum_sha256
        ):
            raise SitePrintError("site_print_layout_image_not_sealed")
        image = _decode_png(body)
        total_pixels += image.width * image.height
        if total_pixels > MAX_PRINT_PIXELS:
            raise SitePrintError("site_print_pixel_budget_exceeded")
        decoded[object_id] = image
    return decoded


def _layout_page_blocks(
    publication: PublishedSite, layout_page: PrintLayoutPage
) -> dict[str, dict[str, object]]:
    page = next(
        (
            candidate
            for candidate in publication.site.pages
            if candidate.slug == layout_page.site_page_slug
        ),
        None,
    )
    if page is None:
        raise SitePrintError("site_print_layout_page_not_found")
    raw_blocks = page.resource_content.get("blocks")
    if not isinstance(raw_blocks, list):
        return {}
    result: dict[str, dict[str, object]] = {}
    for raw in raw_blocks:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            continue
        result[cast(str, raw["id"])] = cast(dict[str, object], raw)
    return result


def _content_frame_block(
    element: PrintLayoutElement,
    blocks: dict[str, dict[str, object]],
    expected_type: str,
) -> dict[str, object]:
    block = blocks.get(element.block_id or "")
    if block is None or block.get("type") != expected_type:
        raise SitePrintError("site_print_layout_content_block_not_sealed")
    return block


def _image_frame_object_id(
    element: PrintLayoutElement, blocks: dict[str, dict[str, object]]
) -> UUID:
    block = _content_frame_block(element, blocks, "image")
    try:
        return UUID(str(block["object_id"]))
    except (KeyError, TypeError, ValueError) as error:
        raise SitePrintError("site_print_layout_image_not_sealed") from error


def _content_page(publication: PublishedSite, page: SitePage, options: PrintOptions) -> _PrintPage:
    paragraphs: list[str] = []
    if page.resource_abstract:
        paragraphs.append(page.resource_abstract)
    blocks = page.resource_content.get("blocks")
    if isinstance(blocks, list):
        headings = {
            block.get("id"): block.get("text")
            for block in blocks
            if isinstance(block, dict)
            and block.get("type") == "heading"
            and isinstance(block.get("id"), str)
            and isinstance(block.get("text"), str)
        }
        for block in blocks:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "markdown" and isinstance(block.get("markdown"), str):
                paragraphs.append(_plain_markdown(cast(str, block["markdown"])))
            elif kind == "heading" and isinstance(block.get("text"), str):
                paragraphs.append(cast(str, block["text"]))
            elif (
                kind == "callout"
                and isinstance(block.get("title"), str)
                and isinstance(block.get("markdown"), str)
            ):
                paragraphs.append(
                    f"{str(block.get('tone', 'note')).title()}: {block['title']}. "
                    f"{_plain_markdown(cast(str, block['markdown']))}"
                )
            elif kind == "navigation" and isinstance(block.get("label"), str):
                targets = block.get("heading_block_ids")
                if isinstance(targets, list):
                    labels = [headings.get(target) for target in targets if isinstance(target, str)]
                    if labels and all(isinstance(label, str) for label in labels):
                        paragraphs.append(f"{block['label']}: {'; '.join(cast(list[str], labels))}")
            elif kind == "citation" and isinstance(block.get("title"), str):
                paragraphs.append(f"Citation: {block['title']}")
            elif kind == "map":
                caption = block.get("caption")
                paragraphs.append(
                    f"Map: {caption}" if isinstance(caption, str) else "Map included in appendix."
                )
            elif kind == "table":
                caption = block.get("caption")
                columns = block.get("columns")
                rows = block.get("rows")
                if isinstance(caption, str):
                    paragraphs.append(f"Table: {caption}")
                if isinstance(columns, list) and isinstance(rows, list):
                    paragraphs.append(
                        f"Columns: {', '.join(str(column) for column in columns)}. "
                        f"Rows: {len(rows)}. See the portable HTML edition for the "
                        "accessible table."
                    )
            elif kind == "chart":
                title = block.get("title")
                alt_text = block.get("alt_text")
                if isinstance(title, str) and isinstance(alt_text, str):
                    paragraphs.append(f"Chart: {title}. {alt_text}")
            elif kind == "image":
                alt_text = block.get("alt_text")
                caption = block.get("caption")
                if isinstance(alt_text, str):
                    prefix = f"Image: {caption}. " if isinstance(caption, str) else "Image: "
                    paragraphs.append(f"{prefix}{alt_text}")
            elif kind == "file":
                label = block.get("label")
                description = block.get("description")
                if isinstance(label, str):
                    paragraphs.append(
                        f"File: {label}. {description}"
                        if isinstance(description, str)
                        else f"File: {label}."
                    )
    page_width, page_height = options.page_points
    line_width = max(48, min(180, int((page_width - 80) / 4.7)))
    maximum = max(20, min(180, int((page_height - 135) / 13)))
    lines = _wrap_lines("\n\n".join(paragraphs), width=line_width, maximum=maximum)
    lines += ("", f"Resource {page.resource_id} · version {page.resource_version_number}")
    return _PrintPage(title=page.resource_title, lines=lines[: maximum + 2])


def _map_page(reference: PublishedResourceReference, image: _PdfImage) -> _PrintPage:
    snapshot = reference.snapshot
    if snapshot is None:
        raise SitePrintError("unsealed_site_snapshot")
    details = [
        f"Extent {_extent(snapshot.bbox)} · {snapshot.crs}",
        f"Render {snapshot.render_job_id} · SHA-256 {snapshot.checksum_sha256}",
    ]
    if reference.attribution:
        details.append(f"Attribution: {reference.attribution}")
    if reference.license:
        details.append(f"License: {reference.license}")
    return _PrintPage(title=reference.title, lines=tuple(details), image=image, reference=reference)


def _pdf(
    publication: PublishedSite,
    pages: list[_PrintPage],
    options: PrintOptions,
    decoded: dict[UUID, _PdfImage],
    decoded_assets: dict[UUID, _PdfImage],
) -> bytes:
    objects: list[bytes | None] = []

    def reserve() -> int:
        objects.append(None)
        return len(objects)

    def assign(identifier: int, value: bytes) -> None:
        objects[identifier - 1] = value

    catalog_id = reserve()
    pages_id = reserve()
    fonts = _PdfFontCatalog()
    page_width, page_height = options.page_points
    page_ids: list[int] = []
    pending_pages: list[tuple[int, int, str]] = []
    for sequence, page in enumerate(pages, 1):
        image_objects: list[tuple[str, int]] = []
        image_names: dict[str, str] = {}
        if page.layout_page is not None:
            blocks = _layout_page_blocks(publication, page.layout_page)
            image_index = 0
            for element in page.layout_page.elements:
                image: _PdfImage | None = None
                prefix = "Map"
                if element.type == "map_frame":
                    if element.resource_id is None or element.resource_id not in decoded:
                        raise SitePrintError("site_print_layout_snapshot_not_sealed")
                    image = decoded[element.resource_id]
                elif element.type == "image_frame":
                    object_id = _image_frame_object_id(element, blocks)
                    image = decoded_assets.get(object_id)
                    prefix = "Asset"
                    if image is None:
                        raise SitePrintError("site_print_layout_image_not_sealed")
                if image is None:
                    continue
                name = f"{prefix}{image_index}"
                image_index += 1
                identifier = reserve()
                assign(identifier, _pdf_image_object(image))
                image_objects.append((name, identifier))
                image_names[element.element_id] = name
        elif page.image is not None:
            identifier = reserve()
            assign(identifier, _pdf_image_object(page.image))
            image_objects.append(("Map", identifier))
        content_id = reserve()
        page_id = reserve()
        page_ids.append(page_id)
        stream = _page_stream(
            publication,
            page,
            sequence,
            len(pages),
            options,
            decoded,
            decoded_assets,
            image_names,
            fonts,
        )
        assign(
            content_id,
            f"<< /Length {len(stream)} >>\n".encode("ascii") + b"stream\n" + stream + b"endstream",
        )
        xobjects = (
            " /XObject << "
            + " ".join(f"/{name} {identifier} 0 R" for name, identifier in image_objects)
            + " >>"
            if image_objects
            else ""
        )
        pending_pages.append((page_id, content_id, xobjects))
    font_objects = _pdf_font_objects(fonts, reserve, assign)
    font_resources = " ".join(
        f"/F{bank + 1} {identifier} 0 R" for bank, identifier in enumerate(font_objects)
    )
    for page_id, content_id, xobjects in pending_pages:
        assign(
            page_id,
            (
                f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 "
                f"{_number(page_width)} {_number(page_height)}] "
                f"/Resources << /Font << {font_resources} >>{xobjects} >> "
                f"/Contents {content_id} 0 R >>"
            ).encode("ascii"),
        )
    assign(
        pages_id,
        (
            f"<< /Type /Pages /Count {len(page_ids)} /Kids "
            f"[{' '.join(f'{identifier} 0 R' for identifier in page_ids)}] >>"
        ).encode("ascii"),
    )
    assign(catalog_id, f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("ascii"))

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for identifier, value in enumerate(objects, 1):
        if value is None:
            raise SitePrintError("pdf_object_unassigned")
        offsets.append(len(output))
        output.extend(f"{identifier} 0 obj\n".encode("ascii"))
        output.extend(value)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def _pdf_font_objects(
    fonts: _PdfFontCatalog,
    reserve: Callable[[], int],
    assign: Callable[[int, bytes], None],
) -> tuple[int, ...]:
    identifiers: list[int] = []
    for bank_index, glyphs in enumerate(fonts.banks, 1):
        font_id = reserve()
        to_unicode_id = reserve()
        char_procs: list[tuple[str, int]] = []
        widths: list[str] = []
        differences: list[str] = []
        mappings: list[str] = []
        for code, glyph in enumerate(glyphs, 1):
            name = f"g{code:03d}"
            char_proc_id = reserve()
            assign(char_proc_id, _pdf_glyph_object(glyph.bitmaps))
            char_procs.append((name, char_proc_id))
            widths.append(str(round(glyph.advance * 1000)))
            differences.append(f"/{name}")
            unicode_hex = glyph.unicode_text.encode("utf-16-be").hex().upper()
            mappings.append(f"<{code:02X}> <{unicode_hex}>")
        mapping_sections = "".join(
            f"{len(chunk)} beginbfchar\n" + "\n".join(chunk) + "\nendbfchar\n"
            for offset in range(0, len(mappings), 100)
            if (chunk := mappings[offset : offset + 100])
        )
        cmap = (
            "/CIDInit /ProcSet findresource begin\n"
            "12 dict begin\n"
            "begincmap\n"
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            "/CMapName /OpenGeo-Unifont-ToUnicode def\n"
            "/CMapType 2 def\n"
            "1 begincodespacerange\n<01> <FF>\nendcodespacerange\n" + mapping_sections + "endcmap\n"
            "CMapName currentdict /CMap defineresource pop\n"
            "end\nend\n"
        ).encode("ascii")
        assign(
            to_unicode_id,
            f"<< /Length {len(cmap)} >>\n".encode("ascii") + b"stream\n" + cmap + b"endstream",
        )
        char_proc_dictionary = " ".join(
            f"/{name} {identifier} 0 R" for name, identifier in char_procs
        )
        base_name = f"OpenGeoUnifont{bank_index}"
        font_width = max(1000, *(round(glyph.advance * 1000) for glyph in glyphs))
        assign(
            font_id,
            (
                f"<< /Type /Font /Subtype /Type3 /Name /F{bank_index} "
                f"/BaseFont /{base_name} /FontBBox [0 -125 {font_width} 875] "
                "/FontMatrix [0.001 0 0 0.001 0 0] "
                f"/CharProcs << {char_proc_dictionary} >> "
                f"/Encoding << /Type /Encoding /Differences [1 {' '.join(differences)}] >> "
                f"/FirstChar 1 /LastChar {len(glyphs)} /Widths [{' '.join(widths)}] "
                f"/Resources << >> /ToUnicode {to_unicode_id} 0 R >>"
            ).encode("ascii"),
        )
        identifiers.append(font_id)
    if not identifiers:
        raise SitePrintError("site_print_unicode_font_empty")
    return tuple(identifiers)


def _pdf_glyph_object(glyphs: tuple[BitmapGlyph, ...]) -> bytes:
    advance = round(sum(0.5 if glyph.width == 8 else 1.0 for glyph in glyphs) * 1000)
    commands = [f"{advance} 0 0 -125 {advance} 875 d1\n"]
    unit = 62.5
    glyph_x = 0.0
    for glyph in glyphs:
        for row_index, row in enumerate(glyph.rows):
            column = 0
            while column < glyph.width:
                bit = 1 << (glyph.width - column - 1)
                if not row & bit:
                    column += 1
                    continue
                start = column
                while column < glyph.width and row & (1 << (glyph.width - column - 1)):
                    column += 1
                commands.append(
                    f"{_number(glyph_x + start * unit)} "
                    f"{_number(812.5 - row_index * unit)} "
                    f"{_number((column - start) * unit)} 62.5 re f\n"
                )
        glyph_x += 500 if glyph.width == 8 else 1000
    program = "".join(commands).encode("ascii")
    compressed = zlib.compress(program, level=9)
    return (
        f"<< /Length {len(compressed)} /Filter /FlateDecode >>\n".encode("ascii")
        + b"stream\n"
        + compressed
        + b"\nendstream"
    )


def _pdf_image_object(image: _PdfImage) -> bytes:
    compressed = zlib.compress(image.rgb, level=9)
    return (
        (
            f"<< /Type /XObject /Subtype /Image /Width {image.width} "
            f"/Height {image.height} /ColorSpace /DeviceRGB "
            f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(compressed)} >>\n"
        ).encode("ascii")
        + b"stream\n"
        + compressed
        + b"\nendstream"
    )


def _page_stream(
    publication: PublishedSite,
    page: _PrintPage,
    sequence: int,
    total: int,
    options: PrintOptions,
    decoded: dict[UUID, _PdfImage],
    decoded_assets: dict[UUID, _PdfImage],
    image_names: dict[str, str],
    fonts: _PdfFontCatalog,
) -> bytes:
    page_width, page_height = options.page_points
    if page.layout_page is not None:
        commands = _pdf_positioned_page(
            publication,
            page.layout_page,
            options,
            decoded,
            decoded_assets,
            image_names,
            fonts,
        )
        footer = (
            f"Edition {publication.edition.edition_number} · page {sequence}/{total} · "
            f"{_page_label(options)} · manifest {publication.edition.manifest_checksum_sha256}"
        )
        commands.append(_pdf_text(fonts, 6, 10, 7, footer, maximum_width=page_width - 20))
        return b"".join(commands)
    commands = [
        _pdf_text(
            fonts,
            19,
            36,
            page_height - 40,
            _truncate(page.title, max(48, int((page_width - 72) / 8.5))),
            maximum_width=page_width - 72,
        ),
        _pdf_text(
            fonts,
            9,
            36,
            page_height - 60,
            _truncate(publication.site.title, max(60, int((page_width - 72) / 6.5))),
            maximum_width=page_width - 72,
        ),
    ]
    if page.image is not None and page.reference is not None and options.layout == "map-sheet":
        commands.extend(_pdf_map_sheet(page.reference, page.image, options, fonts))
    else:
        text_y = page_height - 85.0
        if page.image is not None:
            available_width = page_width - 80.0
            available_height = max(120.0, page_height - 190.0)
            scale = min(available_width / page.image.width, available_height / page.image.height)
            width, height = page.image.width * scale, page.image.height * scale
            x = (page_width - width) / 2.0
            y = 95.0 + (available_height - height) / 2.0
            commands.append(
                f"q {width:.3f} 0 0 {height:.3f} {x:.3f} {y:.3f} cm /Map Do Q\n".encode("ascii")
            )
            text_y = 78.0
        for line in page.lines:
            commands.append(
                _pdf_text(
                    fonts,
                    9,
                    36,
                    text_y,
                    _truncate(line, max(70, int((page_width - 72) / 4.8))),
                    maximum_width=page_width - 72,
                )
            )
            text_y -= 13.0
            if text_y < 43.0:
                break
    footer = (
        f"Edition {publication.edition.edition_number} · page {sequence}/{total} · "
        f"{_page_label(options)} · manifest {publication.edition.manifest_checksum_sha256}"
    )
    commands.append(_pdf_text(fonts, 6, 36, 22, footer, maximum_width=page_width - 72))
    return b"".join(commands)


def _pdf_positioned_page(
    publication: PublishedSite,
    layout_page: PrintLayoutPage,
    options: PrintOptions,
    decoded: dict[UUID, _PdfImage],
    decoded_assets: dict[UUID, _PdfImage],
    image_names: dict[str, str],
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    references = {reference.resource_id: reference for reference in publication.references}
    blocks = _layout_page_blocks(publication, layout_page)
    map_elements = {
        element.element_id: element
        for element in layout_page.elements
        if element.type == "map_frame"
    }
    commands: list[bytes] = []
    for element in layout_page.elements:
        x, y, width, height = _pdf_element_box(element, options)
        frame_commands: list[bytes]
        if element.type == "map_frame":
            if element.resource_id is None:
                raise SitePrintError("site_print_layout_resource_id_invalid")
            image = decoded.get(element.resource_id)
            name = image_names.get(element.element_id)
            if image is None or name is None:
                raise SitePrintError("site_print_layout_snapshot_not_sealed")
            frame_commands = _pdf_image_frame(
                name, image, x, y, width, height, element.fit or "contain", border=True
            )
        elif element.type == "text":
            frame_commands = _pdf_text_frame(element, x, y, width, height, fonts)
        elif element.type == "image_frame":
            object_id = _image_frame_object_id(element, blocks)
            image = decoded_assets.get(object_id)
            name = image_names.get(element.element_id)
            if image is None or name is None:
                raise SitePrintError("site_print_layout_image_not_sealed")
            frame_commands = _pdf_image_frame(
                name, image, x, y, width, height, element.fit or "contain", border=False
            )
        elif element.type == "table_frame":
            frame_commands = _pdf_table_frame(
                _content_frame_block(element, blocks, "table"), x, y, width, height, fonts
            )
        elif element.type == "chart_frame":
            frame_commands = _pdf_chart_frame(
                _content_frame_block(element, blocks, "chart"),
                blocks,
                x,
                y,
                width,
                height,
                fonts,
            )
        else:
            target = map_elements.get(element.map_frame_id or "")
            if target is None or target.resource_id is None:
                raise SitePrintError("site_print_layout_map_frame_not_found")
            reference = references.get(target.resource_id)
            if reference is None or reference.snapshot is None:
                raise SitePrintError("site_print_layout_snapshot_not_sealed")
            if element.type == "source_panel":
                frame_commands = _pdf_source_frame(reference, x, y, width, height, fonts)
            elif element.type == "north_arrow":
                frame_commands = _pdf_north_frame(x, y, width, height, fonts)
            elif element.type == "scale_bar":
                target_width = _pdf_element_box(target, options)[2]
                frame_commands = _pdf_scale_frame(
                    reference, target_width, x, y, width, height, fonts
                )
            elif element.type == "legend_frame":
                if reference.snapshot.legend is None:
                    raise SitePrintError("site_print_layout_legend_not_sealed")
                frame_commands = _pdf_legend_frame(
                    reference.snapshot.legend, x, y, width, height, fonts
                )
            else:
                raise SitePrintError("site_print_layout_element_type_invalid")
        commands.extend(_pdf_transform_frame(element, x, y, width, height, frame_commands))
    return commands


def _pdf_transform_frame(
    element: PrintLayoutElement,
    x: float,
    y: float,
    width: float,
    height: float,
    commands: list[bytes],
) -> list[bytes]:
    if element.rotation == 0 and not element.clip:
        return commands
    prefix = [b"q\n"]
    if element.clip:
        prefix.append(f"{x:.3f} {y:.3f} {width:.3f} {height:.3f} re W n\n".encode("ascii"))
    if element.rotation:
        radians = math.radians(element.rotation)
        cosine = math.cos(radians)
        sine = math.sin(radians)
        center_x = x + width / 2
        center_y = y + height / 2
        translate_x = center_x - cosine * center_x + sine * center_y
        translate_y = center_y - sine * center_x - cosine * center_y
        prefix.append(
            (
                f"{cosine:.8f} {sine:.8f} {-sine:.8f} {cosine:.8f} "
                f"{translate_x:.3f} {translate_y:.3f} cm\n"
            ).encode("ascii")
        )
    return [*prefix, *commands, b"Q\n"]


def _pdf_image_frame(
    name: str,
    image: _PdfImage,
    x: float,
    y: float,
    width: float,
    height: float,
    fit: str,
    *,
    border: bool,
) -> list[bytes]:
    draw_x, draw_y, draw_width, draw_height = _fitted_box(
        x, y, width, height, image.width, image.height, fit
    )
    commands = [
        (
            f"q {draw_width:.3f} 0 0 {draw_height:.3f} {draw_x:.3f} {draw_y:.3f} cm /{name} Do Q\n"
        ).encode("ascii")
    ]
    if border:
        commands.append(
            (
                f"q 0.75 w 0.09 0.13 0.15 RG {x:.3f} {y:.3f} {width:.3f} {height:.3f} re S Q\n"
            ).encode("ascii")
        )
    return commands


def _pdf_element_box(
    element: PrintLayoutElement, options: PrintOptions
) -> tuple[float, float, float, float]:
    page_width, page_height = options.page_points
    x = page_width * element.x / 1000
    width = page_width * element.width / 1000
    height = page_height * element.height / 1000
    y = page_height - page_height * element.y / 1000 - height
    return x, y, width, height


def _fitted_box(
    x: float,
    y: float,
    width: float,
    height: float,
    image_width: int,
    image_height: int,
    fit: str,
) -> tuple[float, float, float, float]:
    if fit not in {"contain", "cover"}:
        raise SitePrintError("site_print_layout_fit_invalid")
    scale = (min if fit == "contain" else max)(width / image_width, height / image_height)
    draw_width = image_width * scale
    draw_height = image_height * scale
    return (
        x + (width - draw_width) / 2,
        y + (height - draw_height) / 2,
        draw_width,
        draw_height,
    )


def _pdf_text_frame(
    element: PrintLayoutElement,
    x: float,
    y: float,
    width: float,
    height: float,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    if element.text is None:
        raise SitePrintError("site_print_layout_text_invalid")
    sizes = {"title": 19, "heading": 14, "body": 9, "note": 8, "attribution": 7}
    size = sizes.get(element.style or "body", 9)
    leading = size * 1.35
    maximum = max(1, int((height - 8) / leading))
    lines = _wrap_pdf_lines(
        element.text,
        fonts,
        maximum_width=max(2.0, (width - 8) / size),
        maximum_lines=maximum,
    )
    commands = [f"q {x:.3f} {y:.3f} {width:.3f} {height:.3f} re W n\n".encode("ascii")]
    text_y = y + height - size - 4
    for line in lines:
        commands.append(_pdf_text(fonts, size, x + 4, text_y, line, maximum_width=width - 8))
        text_y -= leading
    commands.append(b"Q\n")
    return commands


def _pdf_source_frame(
    reference: PublishedResourceReference,
    x: float,
    y: float,
    width: float,
    height: float,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    commands = [
        (f"q 0.75 w 0.09 0.13 0.15 RG {x:.3f} {y:.3f} {width:.3f} {height:.3f} re S Q\n").encode(
            "ascii"
        )
    ]
    text_y = y + height - 13
    for index, line in enumerate(_source_lines(reference, width)):
        size = 9 if index == 0 else 7
        commands.append(_pdf_text(fonts, size, x + 6, text_y, line, maximum_width=width - 12))
        text_y -= 11 if index == 0 else 9
        if text_y < y + 5:
            break
    return commands


def _pdf_legend_frame(
    legend: PublishedMapLegend,
    x: float,
    y: float,
    width: float,
    height: float,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    commands = [
        (
            f"q 0.75 w 0.09 0.13 0.15 RG 1 1 1 rg {x:.3f} {y:.3f} {width:.3f} {height:.3f} re B Q\n"
        ).encode("ascii"),
        _pdf_text(
            fonts,
            9,
            x + 7,
            y + height - 14,
            _truncate(legend.title, max(8, int(width / 5.2))),
            maximum_width=width - 14,
        ),
    ]
    row_height = 13.0
    maximum = max(0, min(len(legend.items), int((height - 22) / row_height)))
    for index, item in enumerate(legend.items[:maximum]):
        row_y = y + height - 28 - index * row_height
        red, green, blue = _blended_rgb(item.color, item.opacity)
        color = f"{red / 255:.4f} {green / 255:.4f} {blue / 255:.4f}"
        if item.symbol == "line":
            commands.append(
                (
                    f"q {color} RG 3 w {x + 7:.3f} {row_y + 4:.3f} m "
                    f"{x + 23:.3f} {row_y + 4:.3f} l S Q\n"
                ).encode("ascii")
            )
        elif item.symbol == "circle":
            commands.append(f"q {color} rg {x + 11:.3f} {row_y:.3f} 8 8 re f Q\n".encode("ascii"))
        else:
            commands.append(
                f"q {color} rg 0.09 0.13 0.15 RG {x + 7:.3f} {row_y:.3f} 16 8 re B Q\n".encode(
                    "ascii"
                )
            )
        commands.append(
            _pdf_text(
                fonts,
                7,
                x + 29,
                row_y + 1,
                _truncate(item.label, max(6, int((width - 36) / 3.8))),
                maximum_width=width - 36,
            )
        )
    return commands


def _pdf_table_frame(
    block: dict[str, object],
    x: float,
    y: float,
    width: float,
    height: float,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    caption, columns, rows = _table_values(block)
    commands = [
        f"q 0.75 w 0.4 0.45 0.48 RG {x:.3f} {y:.3f} {width:.3f} {height:.3f} re S Q\n".encode(
            "ascii"
        ),
        _pdf_text(
            fonts,
            8,
            x + 4,
            y + height - 11,
            _truncate(caption, max(8, int((width - 8) / 4.3))),
            maximum_width=width - 8,
        ),
    ]
    row_height = 11.0
    table_top = y + height - 18
    maximum_rows = max(0, min(len(rows), int((height - 22) / row_height) - 1))
    column_width = width / len(columns)
    displayed: list[list[object]] = [cast(list[object], columns), *rows[:maximum_rows]]
    for row_index, row in enumerate(displayed):
        row_y = table_top - (row_index + 1) * row_height
        if row_index == 0:
            commands.append(
                (
                    f"q 0.94 0.96 0.97 rg {x:.3f} {row_y:.3f} {width:.3f} {row_height:.3f} re f Q\n"
                ).encode("ascii")
            )
        for column_index, cell in enumerate(row):
            cell_x = x + column_index * column_width
            commands.append(
                (
                    f"q 0.8 0.82 0.83 RG 0.35 w {cell_x:.3f} {row_y:.3f} "
                    f"{column_width:.3f} {row_height:.3f} re S Q\n"
                ).encode("ascii")
            )
            commands.append(
                _pdf_text(
                    fonts,
                    7 if row_index == 0 else 6,
                    cell_x + 2,
                    row_y + 3,
                    _truncate(_table_cell(cell), max(2, int((column_width - 4) / 3.4))),
                    maximum_width=column_width - 4,
                )
            )
    return commands


def _pdf_chart_frame(
    block: dict[str, object],
    blocks: dict[str, dict[str, object]],
    x: float,
    y: float,
    width: float,
    height: float,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    title, _alt, chart_type, labels, names, series = _chart_values(block, blocks)
    left = x + max(20.0, width * 0.1)
    bottom = y + max(18.0, height * 0.12)
    chart_width = max(10.0, width - (left - x) - 8)
    chart_height = max(10.0, height - (bottom - y) - 22)
    values = [value for values in series for value in values if value is not None]
    minimum = min(0.0, *values)
    maximum = max(0.0, *values)
    if math.isclose(minimum, maximum):
        maximum = minimum + 1.0

    def chart_y(value: float) -> float:
        return bottom + (value - minimum) * chart_height / (maximum - minimum)

    commands = [
        f"q 0.75 w 0.4 0.45 0.48 RG {x:.3f} {y:.3f} {width:.3f} {height:.3f} re S Q\n".encode(
            "ascii"
        ),
        _pdf_text(
            fonts,
            8,
            x + 5,
            y + height - 11,
            _truncate(title, max(8, int((width - 10) / 4.3))),
            maximum_width=width - 10,
        ),
        (
            f"q 0.4 0.45 0.48 RG 0.6 w {left:.3f} {bottom:.3f} m "
            f"{left:.3f} {bottom + chart_height:.3f} l {left + chart_width:.3f} "
            f"{bottom:.3f} l S Q\n"
        ).encode("ascii"),
    ]
    palette = ("#176b87", "#a33b20", "#27764c", "#7650a8")
    group = chart_width / max(1, len(labels))
    if chart_type == "bar":
        bar_width = group * 0.76 / len(series)
        for series_index, series_values in enumerate(series):
            red, green, blue = _hex_rgb(palette[series_index])
            for index, value in enumerate(series_values):
                if value is None:
                    continue
                zero_y = chart_y(0)
                value_y = chart_y(value)
                bar_x = left + index * group + group * 0.12 + series_index * bar_width
                commands.append(
                    (
                        f"q {red / 255:.4f} {green / 255:.4f} {blue / 255:.4f} rg "
                        f"{bar_x:.3f} {min(zero_y, value_y):.3f} {bar_width:.3f} "
                        f"{max(0.75, abs(zero_y - value_y)):.3f} re f Q\n"
                    ).encode("ascii")
                )
    else:
        for series_index, series_values in enumerate(series):
            red, green, blue = _hex_rgb(palette[series_index])
            points = [
                (left + (index + 0.5) * group, chart_y(value))
                for index, value in enumerate(series_values)
                if value is not None
            ]
            if points:
                path = " ".join(
                    f"{point_x:.3f} {point_y:.3f} {'m' if index == 0 else 'l'}"
                    for index, (point_x, point_y) in enumerate(points)
                )
                commands.append(
                    (
                        f"q {red / 255:.4f} {green / 255:.4f} {blue / 255:.4f} RG 2 w {path} S Q\n"
                    ).encode("ascii")
                )
    legend = " · ".join(names)
    commands.append(
        _pdf_text(
            fonts,
            6,
            left,
            y + 4,
            _truncate(legend, max(8, int(chart_width / 3.4))),
            maximum_width=chart_width,
        )
    )
    return commands


def _pdf_north_frame(
    x: float, y: float, width: float, height: float, fonts: _PdfFontCatalog
) -> list[bytes]:
    center = x + width / 2
    bottom = y + max(3.0, height * 0.12)
    top = y + height - max(8.0, height * 0.25)
    half = min(width * 0.3, max(3.0, height * 0.18))
    return [
        (
            f"q 0.09 0.13 0.15 rg {center - half:.3f} {bottom:.3f} m "
            f"{center:.3f} {top:.3f} l {center + half:.3f} {bottom:.3f} l h f Q\n"
        ).encode("ascii"),
        _pdf_text(fonts, 8, center - 3, y + height - 8, "N"),
    ]


def _pdf_scale_frame(
    reference: PublishedResourceReference,
    map_width: float,
    x: float,
    y: float,
    width: float,
    height: float,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    calculated, label = _scale_bar(reference, map_width)
    bar_width = min(width, calculated)
    bar_height = max(3.0, min(7.0, height * 0.3))
    half = bar_width / 2
    bar_y = y + max(10.0, (height - bar_height) / 2)
    return [
        (
            f"q 0 0 0 rg {x:.3f} {bar_y:.3f} {half:.3f} {bar_height:.3f} re f "
            f"1 1 1 rg {x + half:.3f} {bar_y:.3f} {half:.3f} {bar_height:.3f} re f "
            f"0 0 0 RG 0.75 w {x:.3f} {bar_y:.3f} {bar_width:.3f} "
            f"{bar_height:.3f} re S Q\n"
        ).encode("ascii"),
        _pdf_text(fonts, 7, x, y + 2, label, maximum_width=width),
    ]


def _pdf_map_sheet(
    reference: PublishedResourceReference,
    image: _PdfImage,
    options: PrintOptions,
    fonts: _PdfFontCatalog,
) -> list[bytes]:
    snapshot = reference.snapshot
    if snapshot is None:
        raise SitePrintError("unsealed_site_snapshot")
    layout = _map_layout(options, image)
    commands = [
        (
            f"q {layout.map_width:.3f} 0 0 {layout.map_height:.3f} "
            f"{layout.map_x:.3f} {layout.map_y:.3f} cm /Map Do Q\n"
        ).encode("ascii"),
        (
            f"q 0.75 w 0.09 0.13 0.15 RG {layout.map_x:.3f} {layout.map_y:.3f} "
            f"{layout.map_width:.3f} {layout.map_height:.3f} re S Q\n"
        ).encode("ascii"),
    ]
    if options.legend and layout.panel_x is not None:
        if snapshot.legend is not None:
            commands.extend(
                _pdf_legend_frame(
                    snapshot.legend,
                    layout.panel_x,
                    layout.panel_y,
                    layout.panel_width,
                    layout.panel_height,
                    fonts,
                )
            )
        else:
            commands.extend(
                _pdf_text_frame(
                    PrintLayoutElement(
                        "legend_unavailable",
                        "text",
                        0,
                        0,
                        10,
                        10,
                        text="Style legend was not enabled for this sealed render.",
                        style="note",
                    ),
                    layout.panel_x,
                    layout.panel_y,
                    layout.panel_width,
                    layout.panel_height,
                    fonts,
                )
            )
    if options.north_arrow:
        x = layout.map_x + layout.map_width - 22
        top = layout.map_y + layout.map_height - 16
        commands.extend(
            [
                (
                    f"q 0.09 0.13 0.15 rg {x:.3f} {top - 30:.3f} m "
                    f"{x + 8:.3f} {top - 6:.3f} l {x + 16:.3f} "
                    f"{top - 30:.3f} l h f Q\n"
                ).encode("ascii"),
                _pdf_text(fonts, 9, x + 4, top, "N"),
            ]
        )
    if options.scale_bar:
        bar_width, label = _scale_bar(reference, layout.map_width)
        x, y = layout.map_x, 86.0
        half = bar_width / 2
        commands.extend(
            [
                (
                    f"q 0 0 0 rg {x:.3f} {y:.3f} {half:.3f} 6 re f 1 1 1 rg "
                    f"{x + half:.3f} {y:.3f} {half:.3f} 6 re f 0 0 0 RG 0.75 w "
                    f"{x:.3f} {y:.3f} {bar_width:.3f} 6 re S Q\n"
                ).encode("ascii"),
                _pdf_text(fonts, 8, x, y - 11, label, maximum_width=layout.map_width),
            ]
        )
    page_width, _ = options.page_points
    commands.extend(
        [
            _pdf_text(
                fonts,
                8,
                36,
                65,
                _truncate(_map_attribution(reference), max(70, int((page_width - 72) / 5.2))),
                maximum_width=page_width - 72,
            ),
            _pdf_text(
                fonts,
                6,
                36,
                50,
                f"Map SHA-256 {snapshot.checksum_sha256}",
                maximum_width=page_width - 72,
            ),
        ]
    )
    return commands


def _map_layout(options: PrintOptions, image: _PdfImage) -> _MapLayout:
    page_width, page_height = options.page_points
    margin = 36.0
    gap = 14.0
    panel_width = min(190.0, max(130.0, page_width * 0.22)) if options.legend else 0.0
    frame_width = page_width - margin * 2 - panel_width - (gap if options.legend else 0)
    frame_height = page_height - 194.0
    if frame_width < 120 or frame_height < 120:
        raise SitePrintError("site_print_page_too_small")
    scale = min(frame_width / image.width, frame_height / image.height)
    map_width, map_height = image.width * scale, image.height * scale
    map_x = margin + (frame_width - map_width) / 2
    map_y = 110.0 + (frame_height - map_height) / 2
    panel_x = page_width - margin - panel_width if options.legend else None
    return _MapLayout(
        map_x=map_x,
        map_y=map_y,
        map_width=map_width,
        map_height=map_height,
        panel_x=panel_x,
        panel_y=110.0,
        panel_width=panel_width,
        panel_height=frame_height,
    )


def _source_lines(reference: PublishedResourceReference, panel_width: float) -> tuple[str, ...]:
    width = max(18, int((panel_width - 20) / 4.8))
    values = ["Sources", reference.title]
    if reference.attribution:
        values.append(f"Attribution: {reference.attribution}")
    if reference.license:
        values.append(f"License: {reference.license}")
    lines: list[str] = []
    for value in values:
        lines.extend(textwrap.wrap(value, width=width, break_long_words=False) or [""])
    return tuple(lines[:24])


def _svg_legend(
    legend: PublishedMapLegend | None,
    x: float,
    top: float,
    width: float,
    height: float,
) -> list[str]:
    if legend is None:
        return [
            f'<text x="{x:.3f}" y="{top:.3f}" class="legend-line">'
            "Style legend was not enabled for this sealed render.</text>"
        ]
    result = [
        f'<text x="{x:.3f}" y="{top:.3f}" class="legend-title">'
        f"{escape(_truncate(legend.title, max(8, int(width / 5.2))))}</text>"
    ]
    maximum = max(0, min(len(legend.items), int((height - 16) / 14)))
    for index, item in enumerate(legend.items[:maximum]):
        row_y = top + 14 + index * 14
        red, green, blue = _blended_rgb(item.color, item.opacity)
        color = f"#{red:02x}{green:02x}{blue:02x}"
        if item.symbol == "line":
            result.append(
                f'<line x1="{x:.3f}" y1="{row_y - 3:.3f}" x2="{x + 16:.3f}" '
                f'y2="{row_y - 3:.3f}" stroke="{color}" stroke-width="3"/>'
            )
        elif item.symbol == "circle":
            result.append(f'<circle cx="{x + 8:.3f}" cy="{row_y - 4:.3f}" r="4" fill="{color}"/>')
        else:
            result.append(
                f'<rect x="{x:.3f}" y="{row_y - 10:.3f}" width="16" height="8" '
                f'fill="{color}" stroke="#172026" stroke-width="0.5"/>'
            )
        result.append(
            f'<text x="{x + 22:.3f}" y="{row_y:.3f}" class="legend-line">'
            f"{escape(_truncate(item.label, max(6, int((width - 25) / 4.2))))}</text>"
        )
    return result


def _svg_north_arrow(layout: _MapLayout, page_height: float) -> list[str]:
    x = layout.map_x + layout.map_width - 22
    top_pdf = layout.map_y + layout.map_height - 16
    top = page_height - top_pdf
    return [
        (
            f'<polygon points="{x:.3f},{top + 30:.3f} {x + 8:.3f},{top + 6:.3f} '
            f'{x + 16:.3f},{top + 30:.3f}" fill="#172026"/>'
        ),
        f'<text x="{x + 4:.3f}" y="{top:.3f}" class="furniture">N</text>',
    ]


def _svg_scale_bar(
    reference: PublishedResourceReference, layout: _MapLayout, page_height: float
) -> list[str]:
    width, label = _scale_bar(reference, layout.map_width)
    x, top = layout.map_x, page_height - 92.0
    half = width / 2
    return [
        f'<rect x="{x:.3f}" y="{top:.3f}" width="{half:.3f}" height="6" fill="#172026"/>',
        (
            f'<rect x="{x + half:.3f}" y="{top:.3f}" width="{half:.3f}" height="6" '
            'fill="#ffffff" stroke="#172026" stroke-width="0.75"/>'
        ),
        (
            f'<rect x="{x:.3f}" y="{top:.3f}" width="{width:.3f}" height="6" '
            'fill="none" stroke="#172026" stroke-width="0.75"/>'
        ),
        f'<text x="{x:.3f}" y="{top + 18:.3f}" class="legend-line">{escape(label)}</text>',
    ]


def _raster_dimensions(options: PrintOptions) -> tuple[int, int]:
    page_width, page_height = options.page_points
    width = round(page_width * PRINT_RASTER_DPI / 72)
    height = round(page_height * PRINT_RASTER_DPI / 72)
    if width * height > MAX_PRINT_PIXELS:
        raise SitePrintError("site_print_page_pixel_budget_exceeded")
    return width, height


def _raster_positioned_page(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    publication: PublishedSite,
    layout_page: PrintLayoutPage,
    decoded: dict[UUID, _PdfImage],
    decoded_assets: dict[UUID, _PdfImage],
) -> None:
    references = {reference.resource_id: reference for reference in publication.references}
    blocks = _layout_page_blocks(publication, layout_page)
    map_elements = {
        element.element_id: element
        for element in layout_page.elements
        if element.type == "map_frame"
    }
    for element in layout_page.elements:
        x, y, width, height = _raster_element_box(element, page_width, page_height)
        target = map_elements.get(element.map_frame_id or "")
        target_width = (
            _raster_element_box(target, page_width, page_height)[2] if target is not None else 0
        )
        if element.rotation:
            layer = bytearray(b"\xff" * (width * height * 3))
            _draw_raster_positioned_element(
                layer,
                width,
                height,
                element,
                0,
                0,
                width,
                height,
                target,
                target_width,
                references,
                blocks,
                decoded,
                decoded_assets,
            )
            _composite_rotated_layer(
                canvas,
                page_width,
                page_height,
                bytes(layer),
                x,
                y,
                width,
                height,
                element.rotation,
                element.clip,
            )
        else:
            _draw_raster_positioned_element(
                canvas,
                page_width,
                page_height,
                element,
                x,
                y,
                width,
                height,
                target,
                target_width,
                references,
                blocks,
                decoded,
                decoded_assets,
            )


def _draw_raster_positioned_element(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    element: PrintLayoutElement,
    x: int,
    y: int,
    width: int,
    height: int,
    target: PrintLayoutElement | None,
    target_width: int,
    references: dict[UUID, PublishedResourceReference],
    blocks: dict[str, dict[str, object]],
    decoded: dict[UUID, _PdfImage],
    decoded_assets: dict[UUID, _PdfImage],
) -> None:
    if element.type == "map_frame":
        if element.resource_id is None or element.resource_id not in decoded:
            raise SitePrintError("site_print_layout_snapshot_not_sealed")
        _draw_image_fit(
            canvas,
            page_width,
            page_height,
            decoded[element.resource_id],
            x,
            y,
            width,
            height,
            element.fit or "contain",
        )
        _draw_rect(canvas, page_width, page_height, x, y, width, height, (23, 32, 38))
    elif element.type == "image_frame":
        object_id = _image_frame_object_id(element, blocks)
        image = decoded_assets.get(object_id)
        if image is None:
            raise SitePrintError("site_print_layout_image_not_sealed")
        _draw_image_fit(
            canvas,
            page_width,
            page_height,
            image,
            x,
            y,
            width,
            height,
            element.fit or "contain",
        )
    elif element.type == "text":
        if element.text is None:
            raise SitePrintError("site_print_layout_text_invalid")
        scale = {
            "title": 4,
            "heading": 3,
            "body": 2,
            "note": 2,
            "attribution": 1,
        }.get(element.style or "body", 2)
        _draw_text_block(
            canvas,
            page_width,
            page_height,
            element.text,
            x + 4,
            y + 4,
            max(1, width - 8),
            max(1, height - 8),
            scale,
            (23, 32, 38),
        )
    elif element.type == "table_frame":
        _draw_raster_table(
            canvas,
            page_width,
            page_height,
            _content_frame_block(element, blocks, "table"),
            x,
            y,
            width,
            height,
        )
    elif element.type == "chart_frame":
        _draw_raster_chart(
            canvas,
            page_width,
            page_height,
            _content_frame_block(element, blocks, "chart"),
            blocks,
            x,
            y,
            width,
            height,
        )
    else:
        if target is None or target.resource_id is None:
            raise SitePrintError("site_print_layout_map_frame_not_found")
        reference = references.get(target.resource_id)
        if reference is None or reference.snapshot is None:
            raise SitePrintError("site_print_layout_snapshot_not_sealed")
        if element.type == "source_panel":
            _fill_rect(canvas, page_width, page_height, x, y, width, height, (250, 251, 252))
            _draw_rect(canvas, page_width, page_height, x, y, width, height, (23, 32, 38))
            _draw_text_block(
                canvas,
                page_width,
                page_height,
                "\n".join(_source_lines(reference, max(40.0, width * 0.75))),
                x + 5,
                y + 5,
                max(1, width - 10),
                max(1, height - 10),
                1,
                (23, 32, 38),
            )
        elif element.type == "north_arrow":
            _draw_raster_north(canvas, page_width, page_height, x, y, width, height)
        elif element.type == "scale_bar":
            _draw_raster_scale(
                canvas,
                page_width,
                page_height,
                reference,
                target_width,
                x,
                y,
                width,
                height,
            )
        elif element.type == "legend_frame":
            if reference.snapshot.legend is None:
                raise SitePrintError("site_print_layout_legend_not_sealed")
            _draw_raster_legend(
                canvas,
                page_width,
                page_height,
                reference.snapshot.legend,
                x,
                y,
                width,
                height,
            )
        else:
            raise SitePrintError("site_print_layout_element_type_invalid")


def _composite_rotated_layer(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    layer: bytes,
    x: int,
    y: int,
    width: int,
    height: int,
    rotation: int,
    clip: bool,
) -> None:
    radians = math.radians(rotation)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    center_x = x + width / 2
    center_y = y + height / 2
    if clip:
        left, top, right, bottom = x, y, x + width, y + height
    else:
        corners = [
            (
                center_x + cosine * dx - sine * dy,
                center_y + sine * dx + cosine * dy,
            )
            for dx, dy in (
                (-width / 2, -height / 2),
                (width / 2, -height / 2),
                (-width / 2, height / 2),
                (width / 2, height / 2),
            )
        ]
        left = math.floor(min(point[0] for point in corners))
        top = math.floor(min(point[1] for point in corners))
        right = math.ceil(max(point[0] for point in corners))
        bottom = math.ceil(max(point[1] for point in corners))
    source = memoryview(layer)
    for target_y in range(max(0, top), min(page_height, bottom)):
        for target_x in range(max(0, left), min(page_width, right)):
            delta_x = target_x + 0.5 - center_x
            delta_y = target_y + 0.5 - center_y
            source_x = round(cosine * delta_x + sine * delta_y + width / 2 - 0.5)
            source_y = round(-sine * delta_x + cosine * delta_y + height / 2 - 0.5)
            if not 0 <= source_x < width or not 0 <= source_y < height:
                continue
            source_offset = (source_y * width + source_x) * 3
            target_offset = (target_y * page_width + target_x) * 3
            canvas[target_offset : target_offset + 3] = source[source_offset : source_offset + 3]


def _raster_flow_page(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    publication: PublishedSite,
    page: _PrintPage,
) -> None:
    margin = max(24, round(36 * PRINT_RASTER_DPI / 72))
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        page.title,
        margin,
        margin,
        page_width - margin * 2,
        55,
        4,
        (23, 32, 38),
    )
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        publication.site.title,
        margin,
        margin + 60,
        page_width - margin * 2,
        25,
        2,
        (67, 81, 90),
    )
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        "\n".join(page.lines),
        margin,
        margin + 100,
        page_width - margin * 2,
        max(1, page_height - margin * 2 - 125),
        2,
        (23, 32, 38),
    )


def _raster_footer(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    publication: PublishedSite,
    page_slug: str,
    options: PrintOptions,
) -> None:
    height = 16
    top = page_height - height
    _fill_rect(canvas, page_width, page_height, 0, top, page_width, height, (255, 255, 255))
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        (
            f"EDITION {publication.edition.edition_number}  PAGE {page_slug}  "
            f"{_page_label(options)}  MANIFEST {publication.edition.manifest_checksum_sha256}"
        ),
        6,
        top + 4,
        page_width - 12,
        9,
        1,
        (67, 81, 90),
    )


def _raster_element_box(
    element: PrintLayoutElement, page_width: int, page_height: int
) -> tuple[int, int, int, int]:
    x = round(page_width * element.x / 1000)
    y = round(page_height * element.y / 1000)
    width = max(1, round(page_width * element.width / 1000))
    height = max(1, round(page_height * element.height / 1000))
    return x, y, min(width, page_width - x), min(height, page_height - y)


def _draw_image_fit(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    image: _PdfImage,
    x: int,
    y: int,
    width: int,
    height: int,
    fit: str,
) -> None:
    if fit not in {"contain", "cover"}:
        raise SitePrintError("site_print_layout_fit_invalid")
    scale = (min if fit == "contain" else max)(width / image.width, height / image.height)
    draw_width = image.width * scale
    draw_height = image.height * scale
    left = x + (width - draw_width) / 2
    top = y + (height - draw_height) / 2
    source = memoryview(image.rgb)
    for target_y in range(max(0, y), min(page_height, y + height)):
        source_y = math.floor((target_y + 0.5 - top) / scale)
        if not 0 <= source_y < image.height:
            continue
        for target_x in range(max(0, x), min(page_width, x + width)):
            source_x = math.floor((target_x + 0.5 - left) / scale)
            if not 0 <= source_x < image.width:
                continue
            source_offset = (source_y * image.width + source_x) * 3
            target_offset = (target_y * page_width + target_x) * 3
            canvas[target_offset : target_offset + 3] = source[source_offset : source_offset + 3]


def _draw_raster_legend(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    legend: PublishedMapLegend,
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    _fill_rect(canvas, page_width, page_height, x, y, width, height, (255, 255, 255))
    _draw_rect(canvas, page_width, page_height, x, y, width, height, (23, 32, 38))
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        legend.title,
        x + 5,
        y + 5,
        max(1, width - 10),
        9,
        1,
        (23, 32, 38),
    )
    row_height = 12
    maximum = max(0, min(len(legend.items), (height - 18) // row_height))
    for index, item in enumerate(legend.items[:maximum]):
        row_y = y + 18 + index * row_height
        color = _blended_rgb(item.color, item.opacity)
        if item.symbol == "line":
            _fill_rect(canvas, page_width, page_height, x + 5, row_y + 4, 16, 3, color)
        elif item.symbol == "circle":
            _fill_rect(canvas, page_width, page_height, x + 9, row_y + 1, 8, 8, color)
        else:
            _fill_rect(canvas, page_width, page_height, x + 5, row_y + 1, 16, 8, color)
            _draw_rect(canvas, page_width, page_height, x + 5, row_y + 1, 16, 8, (23, 32, 38))
        _draw_text_block(
            canvas,
            page_width,
            page_height,
            item.label,
            x + 27,
            row_y + 1,
            max(1, width - 32),
            8,
            1,
            (23, 32, 38),
        )


def _draw_raster_table(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    block: dict[str, object],
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    caption, columns, rows = _table_values(block)
    _fill_rect(canvas, page_width, page_height, x, y, width, height, (255, 255, 255))
    _draw_rect(canvas, page_width, page_height, x, y, width, height, (67, 81, 90))
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        caption,
        x + 4,
        y + 4,
        max(1, width - 8),
        9,
        1,
        (23, 32, 38),
    )
    row_height = 11
    table_y = y + 16
    maximum_rows = max(0, min(len(rows), (height - 18) // row_height - 1))
    column_width = max(1, width // len(columns))
    displayed: list[list[object]] = [cast(list[object], columns), *rows[:maximum_rows]]
    for row_index, row in enumerate(displayed):
        row_y = table_y + row_index * row_height
        if row_index == 0:
            _fill_rect(
                canvas,
                page_width,
                page_height,
                x,
                row_y,
                width,
                row_height,
                (240, 244, 246),
            )
        for column_index, cell in enumerate(row):
            cell_x = x + column_index * column_width
            cell_width = (
                width - column_index * column_width
                if column_index == len(row) - 1
                else column_width
            )
            _draw_rect(
                canvas,
                page_width,
                page_height,
                cell_x,
                row_y,
                cell_width,
                row_height,
                (180, 188, 192),
            )
            _draw_text_block(
                canvas,
                page_width,
                page_height,
                _table_cell(cell),
                cell_x + 2,
                row_y + 2,
                max(1, cell_width - 4),
                7,
                1,
                (23, 32, 38),
            )


def _draw_raster_chart(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    block: dict[str, object],
    blocks: dict[str, dict[str, object]],
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    title, _alt, chart_type, labels, _names, series = _chart_values(block, blocks)
    _fill_rect(canvas, page_width, page_height, x, y, width, height, (255, 255, 255))
    _draw_rect(canvas, page_width, page_height, x, y, width, height, (67, 81, 90))
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        title,
        x + 5,
        y + 5,
        max(1, width - 10),
        9,
        1,
        (23, 32, 38),
    )
    left = x + max(18, width // 10)
    top = y + 20
    chart_width = max(4, width - (left - x) - 6)
    chart_height = max(4, height - 32)
    values = [value for values in series for value in values if value is not None]
    minimum = min(0.0, *values)
    maximum = max(0.0, *values)
    if math.isclose(minimum, maximum):
        maximum = minimum + 1.0

    def chart_y(value: float) -> int:
        return top + round((maximum - value) * chart_height / (maximum - minimum))

    zero_y = chart_y(0)
    _draw_line(
        canvas, page_width, page_height, left, top, left, top + chart_height, (103, 112, 118)
    )
    _draw_line(
        canvas, page_width, page_height, left, zero_y, left + chart_width, zero_y, (103, 112, 118)
    )
    palette = ((23, 107, 135), (163, 59, 32), (39, 118, 76), (118, 80, 168))
    group = chart_width / max(1, len(labels))
    if chart_type == "bar":
        bar_width = max(1, math.floor(group * 0.76 / len(series)))
        for series_index, series_values in enumerate(series):
            for index, value in enumerate(series_values):
                if value is None:
                    continue
                value_y = chart_y(value)
                bar_x = round(left + index * group + group * 0.12) + series_index * bar_width
                _fill_rect(
                    canvas,
                    page_width,
                    page_height,
                    bar_x,
                    min(zero_y, value_y),
                    bar_width,
                    max(1, abs(zero_y - value_y)),
                    palette[series_index],
                )
    else:
        for series_index, series_values in enumerate(series):
            points = [
                (round(left + (index + 0.5) * group), chart_y(value))
                for index, value in enumerate(series_values)
                if value is not None
            ]
            for start, end in pairwise(points):
                _draw_line(
                    canvas,
                    page_width,
                    page_height,
                    start[0],
                    start[1],
                    end[0],
                    end[1],
                    palette[series_index],
                )


def _draw_line(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    color: tuple[int, int, int],
) -> None:
    delta_x = abs(x2 - x1)
    step_x = 1 if x1 < x2 else -1
    delta_y = -abs(y2 - y1)
    step_y = 1 if y1 < y2 else -1
    error = delta_x + delta_y
    while True:
        _fill_rect(canvas, page_width, page_height, x1, y1, 1, 1, color)
        if x1 == x2 and y1 == y2:
            break
        doubled = 2 * error
        if doubled >= delta_y:
            error += delta_y
            x1 += step_x
        if doubled <= delta_x:
            error += delta_x
            y1 += step_y


def _draw_raster_north(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        "N",
        x,
        y,
        width,
        min(12, height),
        2,
        (23, 32, 38),
    )
    center = x + width // 2
    top = y + min(height - 1, 13)
    bottom = y + height - 1
    for row_y in range(top, bottom + 1):
        ratio = (row_y - top) / max(1, bottom - top)
        half = max(0, round(ratio * width * 0.35))
        _fill_rect(
            canvas,
            page_width,
            page_height,
            center - half,
            row_y,
            half * 2 + 1,
            1,
            (23, 32, 38),
        )


def _draw_raster_scale(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    reference: PublishedResourceReference,
    map_width: int,
    x: int,
    y: int,
    width: int,
    height: int,
) -> None:
    calculated, label = _scale_bar(reference, float(map_width))
    bar_width = max(2, min(width, round(calculated)))
    half = bar_width // 2
    bar_height = max(2, min(7, height // 3))
    bar_y = y + max(0, height - bar_height - 10)
    _fill_rect(canvas, page_width, page_height, x, bar_y, half, bar_height, (23, 32, 38))
    _fill_rect(
        canvas,
        page_width,
        page_height,
        x + half,
        bar_y,
        bar_width - half,
        bar_height,
        (255, 255, 255),
    )
    _draw_rect(canvas, page_width, page_height, x, bar_y, bar_width, bar_height, (23, 32, 38))
    _draw_text_block(
        canvas,
        page_width,
        page_height,
        label,
        x,
        y,
        width,
        max(1, bar_y - y),
        1,
        (23, 32, 38),
    )


def _draw_text_block(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    value: str,
    x: int,
    y: int,
    width: int,
    height: int,
    scale: int,
    color: tuple[int, int, int],
) -> None:
    line_height = 8 * scale
    maximum_lines = max(1, height // line_height)
    lines: list[str] = []
    for paragraph in value.splitlines() or [""]:
        lines.extend(_wrap_raster_line(paragraph, width, scale) or [""])
        if len(lines) >= maximum_lines:
            break
    for row, line in enumerate(lines[:maximum_lines]):
        layout = _print_text_layout(line)
        line_width = _raster_text_advance(line, scale)
        glyph_x = x + max(0, width - line_width) if layout.base_direction == "R" else x
        for character in layout.visual:
            advance = _raster_glyph_advance(character, scale)
            if glyph_x + advance - scale > x + width:
                break
            _draw_glyph(
                canvas,
                page_width,
                page_height,
                character,
                glyph_x,
                y + row * line_height,
                scale,
                color,
            )
            glyph_x += advance


def _wrap_raster_line(value: str, maximum_width: int, scale: int) -> list[str]:
    normalized = " ".join(value.split())
    if not normalized:
        return []
    lines: list[str] = []
    current = ""
    for word in normalized.split(" "):
        candidate = f"{current} {word}" if current else word
        if _raster_text_advance(candidate, scale) <= maximum_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if _raster_text_advance(word, scale) <= maximum_width:
            current = word
            continue
        for cluster in _print_text_clusters(word):
            candidate = current + cluster
            if current and _raster_text_advance(candidate, scale) > maximum_width:
                lines.append(current)
                current = ""
                candidate = cluster
            current = candidate
    if current:
        lines.append(current)
    return lines


def _raster_glyph_advance(character: str, scale: int) -> int:
    return (_bitmap_glyph(character).width // 2 + 1) * scale


def _raster_text_advance(value: str, scale: int) -> int:
    return sum(
        _raster_glyph_advance(character, scale) for character in _print_text_layout(value).visual
    )


def _bitmap_glyph(character: str) -> BitmapGlyph:
    try:
        unifont = configured_unifont()
    except PrintFontError as error:
        raise SitePrintError(str(error)) from error
    glyph = unifont.get(ord(character)) if unifont is not None else None
    return glyph or _fallback_bitmap(character)


def _fallback_bitmap(character: str) -> BitmapGlyph:
    source = _FONT_5X7.get(character.upper())
    if source is not None:
        rows = [0] * 16
        for row_index, bits in enumerate(source):
            target = 1 + row_index * 2
            rows[target] = bits << 2
            rows[target + 1] = bits << 2
        return BitmapGlyph(width=8, rows=tuple(rows))
    codepoint = ord(character)
    rows = [0xFFFF]
    for row_index in range(14):
        shift = row_index * 3 % 21
        rotated = ((codepoint >> shift) | (codepoint << (21 - shift))) & 0x3FFF
        rows.append(0x8001 | rotated)
    rows.append(0xFFFF)
    return BitmapGlyph(width=16, rows=tuple(rows))


def _draw_glyph(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    character: str,
    x: int,
    y: int,
    scale: int,
    color: tuple[int, int, int],
) -> None:
    glyph = _bitmap_glyph(character)
    target_width = glyph.width // 2
    for row in range(8):
        source = glyph.rows[row * 2] | glyph.rows[row * 2 + 1]
        for column in range(target_width):
            shift = glyph.width - column * 2 - 2
            bits = (source >> shift) & 0b11
            if bits:
                _fill_rect(
                    canvas,
                    page_width,
                    page_height,
                    x + column * scale,
                    y + row * scale,
                    scale,
                    scale,
                    color,
                )


def _fill_rect(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    x: int,
    y: int,
    width: int,
    height: int,
    color: tuple[int, int, int],
) -> None:
    left = max(0, x)
    top = max(0, y)
    right = min(page_width, x + width)
    bottom = min(page_height, y + height)
    if left >= right or top >= bottom:
        return
    row = bytes(color) * (right - left)
    for row_y in range(top, bottom):
        offset = (row_y * page_width + left) * 3
        canvas[offset : offset + len(row)] = row


def _draw_rect(
    canvas: bytearray,
    page_width: int,
    page_height: int,
    x: int,
    y: int,
    width: int,
    height: int,
    color: tuple[int, int, int],
) -> None:
    _fill_rect(canvas, page_width, page_height, x, y, width, 1, color)
    _fill_rect(canvas, page_width, page_height, x, y + height - 1, width, 1, color)
    _fill_rect(canvas, page_width, page_height, x, y, 1, height, color)
    _fill_rect(canvas, page_width, page_height, x + width - 1, y, 1, height, color)


def _encode_png(width: int, height: int, rgb: bytes, *, description: str) -> bytes:
    rows = b"".join(
        b"\x00" + rgb[offset : offset + width * 3] for offset in range(0, len(rgb), width * 3)
    )
    encoded_description = description.encode("utf-8")
    return b"".join(
        (
            _PNG_SIGNATURE,
            _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)),
            _png_chunk(b"iTXt", b"Description\x00\x00\x00\x00\x00" + encoded_description),
            _png_chunk(b"tEXt", b"Software\x00OpenGeo deterministic print renderer"),
            _png_chunk(b"IDAT", zlib.compress(rows, level=9)),
            _png_chunk(b"IEND", b""),
        )
    )


def _png_chunk(kind: bytes, value: bytes) -> bytes:
    return (
        struct.pack(">I", len(value))
        + kind
        + value
        + struct.pack(">I", zlib.crc32(kind + value) & 0xFFFFFFFF)
    )


_FONT_5X7 = {
    " ": (0, 0, 0, 0, 0, 0, 0),
    "A": (14, 17, 17, 31, 17, 17, 17),
    "B": (30, 17, 17, 30, 17, 17, 30),
    "C": (14, 17, 16, 16, 16, 17, 14),
    "D": (30, 17, 17, 17, 17, 17, 30),
    "E": (31, 16, 16, 30, 16, 16, 31),
    "F": (31, 16, 16, 30, 16, 16, 16),
    "G": (14, 17, 16, 23, 17, 17, 15),
    "H": (17, 17, 17, 31, 17, 17, 17),
    "I": (14, 4, 4, 4, 4, 4, 14),
    "J": (7, 2, 2, 2, 18, 18, 12),
    "K": (17, 18, 20, 24, 20, 18, 17),
    "L": (16, 16, 16, 16, 16, 16, 31),
    "M": (17, 27, 21, 21, 17, 17, 17),
    "N": (17, 25, 21, 19, 17, 17, 17),
    "O": (14, 17, 17, 17, 17, 17, 14),
    "P": (30, 17, 17, 30, 16, 16, 16),
    "Q": (14, 17, 17, 17, 21, 18, 13),
    "R": (30, 17, 17, 30, 20, 18, 17),
    "S": (15, 16, 16, 14, 1, 1, 30),
    "T": (31, 4, 4, 4, 4, 4, 4),
    "U": (17, 17, 17, 17, 17, 17, 14),
    "V": (17, 17, 17, 17, 17, 10, 4),
    "W": (17, 17, 17, 17, 21, 21, 10),
    "X": (17, 17, 10, 4, 10, 17, 17),
    "Y": (17, 17, 10, 4, 4, 4, 4),
    "Z": (31, 1, 2, 4, 8, 16, 31),
    "0": (14, 17, 19, 21, 25, 17, 14),
    "1": (4, 12, 4, 4, 4, 4, 14),
    "2": (14, 17, 1, 2, 4, 8, 31),
    "3": (30, 1, 1, 14, 1, 1, 30),
    "4": (2, 6, 10, 18, 31, 2, 2),
    "5": (31, 16, 16, 30, 1, 1, 30),
    "6": (14, 16, 16, 30, 17, 17, 14),
    "7": (31, 1, 2, 4, 8, 8, 8),
    "8": (14, 17, 17, 14, 17, 17, 14),
    "9": (14, 17, 17, 15, 1, 1, 14),
    "-": (0, 0, 0, 31, 0, 0, 0),
    ".": (0, 0, 0, 0, 0, 12, 12),
    ",": (0, 0, 0, 0, 4, 4, 8),
    ":": (0, 12, 12, 0, 12, 12, 0),
    "/": (1, 2, 2, 4, 8, 8, 16),
    "_": (0, 0, 0, 0, 0, 0, 31),
    "#": (10, 31, 10, 10, 31, 10, 0),
    "?": (14, 17, 1, 2, 4, 0, 4),
}


def _scale_bar(reference: PublishedResourceReference, map_width: float) -> tuple[float, str]:
    snapshot = reference.snapshot
    if snapshot is None:
        raise SitePrintError("unsealed_site_snapshot")
    ground_width = _ground_width(snapshot.bbox, snapshot.crs)
    target = ground_width * 0.25
    distance = _nice_distance(target)
    width = max(20.0, min(map_width * 0.5, map_width * distance / ground_width))
    return width, _distance_label(distance)


def _ground_width(bbox: tuple[float, float, float, float], crs: str) -> float:
    min_x, min_y, max_x, max_y = bbox
    span = max_x - min_x
    if not math.isfinite(span) or span <= 0:
        raise SitePrintError("site_print_extent_invalid")
    if crs == "CRS:84":
        middle_latitude = math.radians((min_y + max_y) / 2)
        distance = math.radians(span) * 6_378_137.0 * max(0.01, abs(math.cos(middle_latitude)))
    elif crs == "EPSG:3857":
        middle_y = max(-20_037_508.342789244, min(20_037_508.342789244, (min_y + max_y) / 2))
        latitude = math.atan(math.sinh(middle_y / 6_378_137.0))
        distance = span * max(0.01, abs(math.cos(latitude)))
    else:
        raise SitePrintError("site_print_crs_unsupported")
    if not math.isfinite(distance) or distance <= 0:
        raise SitePrintError("site_print_extent_invalid")
    return distance


def _nice_distance(target: float) -> float:
    exponent = math.floor(math.log10(target))
    unit: float = 10.0**exponent
    candidates = (1.0 * unit, 2.0 * unit, 5.0 * unit, 10.0 * unit)
    return max((candidate for candidate in candidates if candidate <= target), default=unit)


def _distance_label(distance: float) -> str:
    if distance >= 1_000:
        return f"{_number(distance / 1_000)} km"
    if distance >= 1:
        return f"{_number(distance)} m"
    if distance >= 0.01:
        return f"{_number(distance * 100)} cm"
    return f"{_number(distance * 1_000)} mm"


def _map_attribution(reference: PublishedResourceReference) -> str:
    values = []
    if reference.attribution:
        values.append(f"Attribution: {reference.attribution}")
    if reference.license:
        values.append(f"License: {reference.license}")
    return " · ".join(values) if values else "No attribution or license was supplied."


def _table_values(
    block: dict[str, object],
) -> tuple[str, list[str], list[list[object]]]:
    caption = block.get("caption")
    columns = block.get("columns")
    rows = block.get("rows")
    if (
        not isinstance(caption, str)
        or not isinstance(columns, list)
        or not 1 <= len(columns) <= 12
        or not all(isinstance(column, str) for column in columns)
        or not isinstance(rows, list)
        or len(rows) > 50
        or any(not isinstance(row, list) or len(row) != len(columns) for row in rows)
    ):
        raise SitePrintError("site_print_layout_table_invalid")
    return caption, cast(list[str], columns), cast(list[list[object]], rows)


def _chart_values(
    block: dict[str, object],
    blocks: dict[str, dict[str, object]],
) -> tuple[str, str, str, list[str], list[str], list[list[float | None]]]:
    title = block.get("title")
    alt_text = block.get("alt_text")
    chart_type = block.get("chart_type")
    table_id = block.get("table_block_id")
    x_column = block.get("x_column")
    y_columns = block.get("y_columns")
    if (
        not isinstance(title, str)
        or not isinstance(alt_text, str)
        or not isinstance(chart_type, str)
        or chart_type not in {"bar", "line"}
        or not isinstance(table_id, str)
        or not isinstance(x_column, str)
        or not isinstance(y_columns, list)
        or not 1 <= len(y_columns) <= 4
        or not all(isinstance(column, str) for column in y_columns)
    ):
        raise SitePrintError("site_print_layout_chart_invalid")
    table = blocks.get(table_id)
    if table is None or table.get("type") != "table":
        raise SitePrintError("site_print_layout_chart_invalid")
    _caption, columns, rows = _table_values(table)
    lookup = {column.casefold(): index for index, column in enumerate(columns)}
    x_index = lookup.get(x_column.casefold())
    y_names = cast(list[str], y_columns)
    y_indexes = [lookup.get(column.casefold()) for column in y_names]
    if x_index is None or any(index is None for index in y_indexes):
        raise SitePrintError("site_print_layout_chart_invalid")
    labels: list[str] = []
    series: list[list[float | None]] = [[] for _ in y_names]
    for row in rows:
        labels.append(_table_cell(row[x_index]))
        for values, raw_index in zip(series, y_indexes, strict=True):
            if raw_index is None:
                raise SitePrintError("site_print_layout_chart_invalid")
            value = row[raw_index]
            if value is None:
                values.append(None)
            elif isinstance(value, bool) or not isinstance(value, (int, float)):
                raise SitePrintError("site_print_layout_chart_invalid")
            else:
                number = float(value)
                if not math.isfinite(number):
                    raise SitePrintError("site_print_layout_chart_invalid")
                values.append(number)
    if not labels or any(not any(value is not None for value in values) for values in series):
        raise SitePrintError("site_print_layout_chart_invalid")
    return title, alt_text, chart_type, labels, y_names, series


def _table_cell(value: object) -> str:
    if value is None:
        return "—"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        return _number(value)
    return str(value)


def _hex_rgb(value: str) -> tuple[int, int, int]:
    if re.fullmatch(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?", value) is None:
        raise SitePrintError("site_print_layout_legend_invalid")
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


def _blended_rgb(value: str, opacity: float) -> tuple[int, int, int]:
    red, green, blue = _hex_rgb(value)
    alpha = int(value[7:9], 16) / 255 if len(value) == 9 else 1.0
    effective = alpha * opacity
    blended = [round(channel * effective + 255 * (1 - effective)) for channel in (red, green, blue)]
    return blended[0], blended[1], blended[2]


def _page_label(options: PrintOptions) -> str:
    return f"{options.page_size.upper()} {options.orientation} · {options.layout}"


def _extent(bbox: tuple[float, float, float, float]) -> str:
    return ", ".join(_number(value) for value in bbox)


def _decode_png(body: bytes) -> _PdfImage:
    if not body.startswith(_PNG_SIGNATURE):
        raise SitePrintError("site_snapshot_not_png")
    offset = len(_PNG_SIGNATURE)
    width = height = bit_depth = color_type = interlace = None
    compressed = bytearray()
    while offset + 12 <= len(body):
        length = struct.unpack(">I", body[offset : offset + 4])[0]
        kind = body[offset + 4 : offset + 8]
        start, end = offset + 8, offset + 8 + length
        if end + 4 > len(body):
            raise SitePrintError("site_snapshot_png_truncated")
        data = body[start:end]
        expected_crc = struct.unpack(">I", body[end : end + 4])[0]
        if zlib.crc32(kind + data) & 0xFFFFFFFF != expected_crc:
            raise SitePrintError("site_snapshot_png_crc_invalid")
        if kind == b"IHDR":
            if length != 13:
                raise SitePrintError("site_snapshot_png_header_invalid")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", data
            )
            if compression != 0 or filtering != 0:
                raise SitePrintError("site_snapshot_png_encoding_unsupported")
        elif kind == b"IDAT":
            compressed.extend(data)
        elif kind == b"IEND":
            break
        offset = end + 4
    if (
        width is None
        or height is None
        or not 1 <= width <= 4096
        or not 1 <= height <= 4096
        or bit_depth != 8
        or color_type not in {2, 6}
        or interlace != 0
    ):
        raise SitePrintError("site_snapshot_png_encoding_unsupported")
    channels = 3 if color_type == 2 else 4
    stride = width * channels
    expected_size = height * (stride + 1)
    try:
        inflater = zlib.decompressobj()
        encoded = inflater.decompress(bytes(compressed), expected_size + 1)
    except zlib.error as error:
        raise SitePrintError("site_snapshot_png_data_invalid") from error
    if len(encoded) != expected_size or inflater.unconsumed_tail or not inflater.eof:
        raise SitePrintError("site_snapshot_png_data_invalid")
    prior = bytearray(stride)
    rgb = bytearray(width * height * 3)
    source_offset = target_offset = 0
    for _ in range(height):
        filter_type = encoded[source_offset]
        source_offset += 1
        row = bytearray(encoded[source_offset : source_offset + stride])
        source_offset += stride
        _unfilter(row, prior, filter_type, channels)
        if channels == 3:
            rgb[target_offset : target_offset + width * 3] = row
            target_offset += width * 3
        else:
            for pixel in range(width):
                source = pixel * 4
                alpha = row[source + 3]
                for channel in range(3):
                    rgb[target_offset] = (
                        row[source + channel] * alpha + 255 * (255 - alpha) + 127
                    ) // 255
                    target_offset += 1
        prior = row
    return _PdfImage(width=width, height=height, rgb=bytes(rgb))


def _unfilter(row: bytearray, prior: bytearray, kind: int, channels: int) -> None:
    if kind not in {0, 1, 2, 3, 4}:
        raise SitePrintError("site_snapshot_png_filter_unsupported")
    for index in range(len(row)):
        left = row[index - channels] if index >= channels else 0
        up = prior[index]
        upper_left = prior[index - channels] if index >= channels else 0
        if kind == 1:
            row[index] = (row[index] + left) & 255
        elif kind == 2:
            row[index] = (row[index] + up) & 255
        elif kind == 3:
            row[index] = (row[index] + ((left + up) // 2)) & 255
        elif kind == 4:
            row[index] = (row[index] + _paeth(left, up, upper_left)) & 255


def _paeth(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    distances = (abs(estimate - left), abs(estimate - up), abs(estimate - upper_left))
    return (left, up, upper_left)[distances.index(min(distances))]


def _plain_markdown(value: str) -> str:
    value = re.sub(r"<[^>]{0,500}>", " ", value)
    value = re.sub(r"!\[([^]]*)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"^[#>*+\-]+\s*", "", value, flags=re.MULTILINE)
    return re.sub(r"[`*_~]", "", value)


def _wrap_lines(value: str, *, width: int, maximum: int) -> tuple[str, ...]:
    lines: list[str] = []
    for paragraph in re.split(r"\n\s*\n", value.strip()):
        normalized = " ".join(paragraph.split())
        if not normalized:
            continue
        lines.extend(textwrap.wrap(normalized, width=width, break_long_words=False))
        lines.append("")
        if len(lines) >= maximum:
            break
    return tuple(lines[:maximum])


def _pdf_text(
    fonts: _PdfFontCatalog,
    size: float,
    x: float,
    y: float,
    value: str,
    *,
    maximum_width: float | None = None,
) -> bytes:
    if maximum_width is not None:
        value = _truncate_pdf_text(value, fonts, maximum_width / size)
    layout = fonts.layout(value)
    text_width = fonts.text_advance(value) * size
    text_x = (
        x + max(0.0, maximum_width - text_width)
        if layout.base_direction == "R" and maximum_width is not None
        else x
    )
    actual_text = (b"\xfe\xff" + value.encode("utf-16-be")).hex().upper()
    commands = [
        f"/Span << /ActualText <{actual_text}> >> BDC\n",
        f"BT {_number(text_x)} {_number(y)} Td ",
    ]
    for bank, encoded in fonts.encode_layout(layout):
        commands.append(f"/F{bank + 1} {_number(size)} Tf <{encoded.hex().upper()}> Tj ")
    commands.append("ET\nEMC\n")
    return "".join(commands).encode("ascii")


def _truncate_pdf_text(value: str, fonts: _PdfFontCatalog, maximum_em: float) -> str:
    if fonts.text_advance(value) <= maximum_em:
        return value
    ellipsis = "…"
    available = maximum_em - fonts.text_advance(ellipsis)
    if available <= 0:
        return ""
    retained: list[str] = []
    for cluster in _print_text_clusters(value):
        candidate = "".join((*retained, cluster))
        if fonts.text_advance(candidate) > available:
            break
        retained.append(cluster)
    return "".join(retained).rstrip() + ellipsis


def _wrap_pdf_lines(
    value: str,
    fonts: _PdfFontCatalog,
    *,
    maximum_width: float,
    maximum_lines: int,
) -> tuple[str, ...]:
    lines: list[str] = []
    for paragraph in re.split(r"\n\s*\n", value.strip()):
        normalized = " ".join(paragraph.split())
        if not normalized:
            continue
        current = ""
        for word in normalized.split(" "):
            candidate = f"{current} {word}" if current else word
            if fonts.text_advance(candidate) <= maximum_width:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ""
                if len(lines) >= maximum_lines:
                    break
            if fonts.text_advance(word) <= maximum_width:
                current = word
                continue
            for cluster in _print_text_clusters(word):
                candidate = current + cluster
                if current and fonts.text_advance(candidate) > maximum_width:
                    lines.append(current)
                    current = ""
                    candidate = cluster
                current = candidate
                if len(lines) >= maximum_lines:
                    break
            if len(lines) >= maximum_lines:
                break
        if current and len(lines) < maximum_lines:
            lines.append(current)
        if len(lines) < maximum_lines:
            lines.append("")
        if len(lines) >= maximum_lines:
            break
    return tuple(lines[:maximum_lines])


def _print_text_layout(value: str) -> PrintTextLayout:
    try:
        return layout_print_text(value)
    except PrintTextError as error:
        raise SitePrintError(str(error)) from error


def _print_text_clusters(value: str) -> tuple[str, ...]:
    try:
        return print_text_clusters(value)
    except PrintTextError as error:
        raise SitePrintError(str(error)) from error


def _truncate(value: str, maximum: int) -> str:
    if len(value) <= maximum:
        return value
    return value[: max(1, maximum - 1)].rstrip() + "…"


def _number(value: float) -> str:
    return f"{value:.8f}".rstrip("0").rstrip(".")


def _sha256(value: bytes) -> str:
    from hashlib import sha256

    return sha256(value).hexdigest()
