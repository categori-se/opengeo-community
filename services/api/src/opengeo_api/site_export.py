# ruff: noqa: E501

import math
import re
from collections.abc import Mapping
from html import escape
from io import BytesIO
from typing import Any, Literal, Protocol, cast
from urllib.parse import urlencode, urlsplit
from uuid import UUID
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from opengeo_api.document_previews import (
    PDF_VISUAL_PRESENTATION_SCHEMAS,
    DocumentPreviewInvalid,
    document_visual_page,
    parse_document_preview,
)
from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.page_renderer_contract import PAGE_RENDERER_VERSION
from opengeo_api.site_layouts import parse_print_layout
from opengeo_api.site_print import build_map_sheet_svg, resolve_print_options
from opengeo_api.site_publications import (
    PublishedResourceReference,
    PublishedSite,
    PublishedSiteAsset,
    SiteAssetCandidate,
    SitePage,
)

SITE_CSS = """
:root{color-scheme:light;--ink:#172026;--paper:#fff;--muted:#5c6770;--accent:#176b87;--line:#d6dde1;--measure:76ch}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.6 system-ui,sans-serif}
a{color:var(--accent)}header,main,footer{width:min(100% - 2rem,1100px);margin-inline:auto}header{padding:2rem 0 1rem;border-bottom:1px solid var(--line)}
header p{max-width:var(--measure);color:var(--muted)}nav ul{display:flex;flex-wrap:wrap;gap:.5rem 1.2rem;padding:0;list-style:none}nav a[aria-current=page]{font-weight:700;text-decoration-thickness:3px}
main{padding:2rem 0 4rem}.content{max-width:var(--measure)}.resource-card,.map-embed,.citation{margin:1.5rem 0;padding:1rem;border:1px solid var(--line);border-radius:.35rem}
.map-embed img{display:block;width:100%;height:auto;object-fit:contain;background:#edf1f2}.map-controls{display:flex;gap:.5rem;margin:.75rem 0}.map-controls button{min-width:2.75rem;min-height:2.75rem}
.fallback{color:var(--muted)}footer{padding:1.5rem 0;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}.theme-atlas{--accent:#176340;--paper:#fbf8ef}.theme-minimal header{border:0}.theme-minimal nav{border-block:1px solid var(--line)}
blockquote{border-left:.3rem solid var(--line);margin-left:0;padding-left:1rem;color:var(--muted)}code{background:#f1f3f4;padding:.1rem .25rem}h1,h2,h3,h4{line-height:1.2}
.structural-heading{scroll-margin-top:1rem}.heading-anchor{font-size:.75em;margin-left:.35rem;text-decoration:none;color:var(--muted)}.heading-anchor:focus,.heading-anchor:hover{color:var(--accent);text-decoration:underline}.page-navigation{margin:1.5rem 0;padding:1rem;border-block:1px solid var(--line)}.page-navigation p{margin-top:0;font-weight:700}.page-navigation ol{display:grid;gap:.25rem;margin-bottom:0}.callout{margin:1.5rem 0;padding:1rem 1.1rem;border:1px solid var(--line);border-left:.4rem solid var(--accent);border-radius:.35rem}.callout-title{font-weight:700;margin-top:0}.callout-note{--accent:#176b87}.callout-tip{--accent:#27764c}.callout-warning{--accent:#a35b20}.callout-important{--accent:#7650a8}
.data-table,.chart-block,.content-image{margin:1.5rem 0;overflow-x:auto}.data-table table{border-collapse:collapse;width:100%;font-size:.95rem}.data-table caption,.chart-block figcaption,.content-image figcaption{text-align:left;font-weight:700;margin-bottom:.5rem}.data-table th,.data-table td{border:1px solid var(--line);padding:.45rem;text-align:left;vertical-align:top}.data-table th{background:#f3f6f7}.chart-block svg{display:block;width:100%;height:auto;border:1px solid var(--line);background:#fff}.chart-block .chart-description{color:var(--muted)}.content-image img{display:block;max-width:100%;height:auto}.file-description{color:var(--muted)}
.document-preview{margin:1.5rem 0;border:1px solid var(--line);border-radius:.35rem;padding:1rem}.document-preview>header{width:auto;margin:0;padding:0;border:0}.document-preview h2{margin-top:0}.document-title,.document-fidelity,.document-page-label{color:var(--muted)}.document-page{padding-top:1rem;border-top:1px solid var(--line)}.document-page+.document-page{margin-top:2rem}.document-page-visual{margin:1rem 0}.document-page-visual img{display:block;max-width:100%;height:auto;border:1px solid var(--line);background:#fff}.document-table{overflow-x:auto}.document-table table{border-collapse:collapse;width:100%;font-size:.95rem}.document-table caption{text-align:left;font-weight:700}.document-table th,.document-table td{border:1px solid var(--line);padding:.45rem;text-align:left;vertical-align:top}.document-table th{background:#f3f6f7}
@media(max-width:600px){body{font-size:16px}header{padding-top:1rem}.map-controls button{flex:1}}
@media print{body{font-size:11pt}header,main,footer{width:100%}nav,.map-controls,.interactive-note{display:none!important}a{color:inherit;text-decoration:none}.map-embed,.resource-card,.data-table,.chart-block,.document-page-visual{break-inside:avoid}.map-embed img{max-height:6in}.document-page{break-after:page}.document-page:last-child{break-after:auto}footer{break-before:auto}}
""".strip()

SITE_JS = """
(()=>{const WORLD=20037508.342789244;for(const frame of document.querySelectorAll('[data-wms-url]')){const image=frame.querySelector('img'),fallback=image.dataset.staticSrc;image.addEventListener('error',()=>{if(fallback&&image.getAttribute('src')!==fallback)image.src=fallback});let box=[-WORLD,-WORLD,WORLD,WORLD];const draw=()=>{const query=new URLSearchParams({SERVICE:'WMS',VERSION:'1.3.0',REQUEST:'GetMap',LAYERS:frame.dataset.layer,STYLES:'',CRS:'EPSG:3857',BBOX:box.join(','),WIDTH:'960',HEIGHT:'540',FORMAT:'image/png',TRANSPARENT:'TRUE'});image.src=frame.dataset.wmsUrl+'?'+query};frame.querySelector('[data-map-zoom-in]')?.addEventListener('click',()=>{const [a,b,c,d]=box;const x=(a+c)/2,y=(b+d)/2,w=(c-a)/4,h=(d-b)/4;box=[x-w,y-h,x+w,y+h];draw()});frame.querySelector('[data-map-zoom-out]')?.addEventListener('click',()=>{const [a,b,c,d]=box;const x=(a+c)/2,y=(b+d)/2,w=Math.min(WORLD,(c-a)),h=Math.min(WORLD,(d-b));box=[x-w,y-h,x+w,y+h];draw()});frame.querySelector('[data-map-reset]')?.addEventListener('click',()=>{box=[-WORLD,-WORLD,WORLD,WORLD];draw()});draw()}})();
""".strip()

SITE_CSP = (
    "default-src 'self'; img-src 'self' data: https:; "
    "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'"
)

PAGE_PREVIEW_CSP = (
    "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; "
    "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'"
)

_MARKDOWN_LINK = re.compile(r"\[([^\]\n]{1,300})\]\((https://[^\s)]+)\)")
_ACCENT_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_BLOCK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class ResourceReferenceView(Protocol):
    @property
    def resource_id(self) -> UUID: ...

    @property
    def version_number(self) -> int: ...

    @property
    def kind(self) -> str: ...

    @property
    def title(self) -> str: ...

    @property
    def abstract(self) -> str | None: ...

    @property
    def attribution(self) -> str | None: ...

    @property
    def license(self) -> str | None: ...

    @property
    def wms_service_id(self) -> UUID | None: ...

    @property
    def wms_layer_name(self) -> str | None: ...

    @property
    def snapshot(self) -> Any: ...


def render_page_html(
    publication: PublishedSite,
    page: SitePage,
    *,
    page_urls: dict[str, str],
    css_url: str,
    js_url: str,
    public_project_root: str,
    snapshot_urls: dict[UUID, str] | None = None,
    asset_urls: dict[UUID, str] | None = None,
    document_previews: dict[UUID, dict[str, Any]] | None = None,
    document_visual_urls: dict[UUID, dict[int, str]] | None = None,
) -> bytes:
    site = publication.site
    references = {reference.resource_id: reference for reference in publication.references}
    navigation = "".join(
        '<li><a href="{}"{}>{}</a></li>'.format(
            escape(page_urls[candidate.slug], quote=True),
            ' aria-current="page"' if candidate.slug == page.slug else "",
            escape(candidate.navigation_label),
        )
        for candidate in site.pages
    )
    body = render_content_blocks(
        resource_id=page.resource_id,
        resource_kind=page.resource_kind,
        resource_abstract=page.resource_abstract,
        resource_content=page.resource_content,
        references=references,
        assets={asset.object_id: asset for asset in publication.assets},
        public_project_root=public_project_root,
        snapshot_urls=snapshot_urls or {},
        asset_urls=asset_urls or {},
        document_previews=document_previews or {},
        document_visual_urls=document_visual_urls or {},
    )
    description = f"<p>{escape(site.description)}</p>" if site.description is not None else ""
    attribution = (
        f"<p>Attribution: {escape(page.resource_attribution)}</p>"
        if page.resource_attribution
        else ""
    )
    license_text = (
        f"<p>License: {escape(page.resource_license)}</p>" if page.resource_license else ""
    )
    accent = site.theme_options.get("accentColor")
    theme_style = (
        f' style="--accent:{accent}"'
        if isinstance(accent, str) and _ACCENT_COLOR.fullmatch(accent)
        else ""
    )
    footer_text = site.theme_options.get("footerText")
    custom_footer = f"<p>{escape(footer_text)}</p>" if isinstance(footer_text, str) else ""
    html = f"""<!doctype html>
<html lang="{escape(site.language, quote=True)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{SITE_CSP}">
<meta name="generator" content="{PAGE_RENDERER_VERSION}">
<title>{escape(page.resource_title)} · {escape(site.title)}</title>
<link rel="stylesheet" href="{escape(css_url, quote=True)}">
</head>
<body class="theme-{escape(site.theme, quote=True)}" data-edition-id="{publication.edition.edition_id}" data-renderer-version="{PAGE_RENDERER_VERSION}"{theme_style}>
<header>
<p><strong>{escape(site.title)}</strong></p>{description}
<nav aria-label="Project pages"><ul>{navigation}</ul></nav>
</header>
<main id="main-content"><article class="content">
<h1>{escape(page.resource_title)}</h1>{body}
</article></main>
<footer>
{attribution}{license_text}{custom_footer}
<p>Edition {publication.edition.edition_number}; published {escape(publication.edition.published_at.isoformat())}. Downloaded and printed copies cannot be recalled after platform revocation.</p>
</footer>
<script src="{escape(js_url, quote=True)}" defer></script>
</body></html>"""
    return html.encode("utf-8")


def build_static_package(
    publication: PublishedSite,
    *,
    public_project_root: str,
    map_images: dict[UUID, bytes] | None = None,
    site_assets: dict[UUID, bytes] | None = None,
) -> bytes:
    site = publication.site
    page_urls = {
        page.slug: ("index.html" if page.is_home else f"{page.slug}.html") for page in site.pages
    }
    images = map_images or {}
    reference_by_id = {reference.resource_id: reference for reference in publication.references}
    for resource_id, content in images.items():
        reference = reference_by_id.get(resource_id)
        if reference is None or reference.snapshot is None:
            raise ValueError("unsealed site snapshot")
        if (
            len(content) != reference.snapshot.size_bytes
            or _sha256(content) != reference.snapshot.checksum_sha256
        ):
            raise ValueError("site snapshot checksum mismatch")
    snapshot_urls = {resource_id: f"assets/maps/{resource_id}.png" for resource_id in images}
    assets = site_assets or {}
    asset_by_id = {asset.object_id: asset for asset in publication.assets}
    for object_id, content in assets.items():
        asset = asset_by_id.get(object_id)
        if asset is None:
            raise ValueError("unsealed site asset")
        if len(content) != asset.size_bytes or _sha256(content) != asset.checksum_sha256:
            raise ValueError("site asset checksum mismatch")
    if set(assets) != set(asset_by_id):
        raise ValueError("site asset bytes are incomplete")
    asset_urls = {
        object_id: f"assets/content/{object_id}/{asset_by_id[object_id].filename}"
        for object_id in assets
    }
    document_previews: dict[UUID, dict[str, Any]] = {}
    document_visual_urls: dict[UUID, dict[int, str]] = {}
    document_visual_files: dict[str, bytes] = {}
    for object_id, asset in asset_by_id.items():
        if asset.kind != "document":
            continue
        try:
            preview = parse_document_preview(assets[object_id])
            document_previews[object_id] = preview
            if preview.get("schemaVersion") in PDF_VISUAL_PRESENTATION_SCHEMAS:
                visual_urls: dict[int, str] = {}
                for visual_page in cast(list[dict[str, Any]], preview["pages"]):
                    number = cast(int, visual_page["number"])
                    image, _digest = document_visual_page(preview, number)
                    path = f"assets/documents/{object_id}/page-{number}.jpg"
                    document_visual_files[path] = image
                    visual_urls[number] = path
                document_visual_urls[object_id] = visual_urls
        except (KeyError, DocumentPreviewInvalid) as error:
            raise ValueError("sealed document preview is invalid") from error
    files: dict[str, bytes] = {
        "assets/site.css": SITE_CSS.encode("utf-8"),
        "assets/site.js": SITE_JS.encode("utf-8"),
        "manifest.json": canonical_json_bytes(publication.edition.manifest),
        "metadata/site.json": canonical_json_bytes(
            {
                "title": site.title,
                "description": site.description,
                "language": site.language,
                "theme": site.theme,
                "themeOptions": site.theme_options,
                "printLayout": site.print_layout,
                "siteId": str(site.site_id),
                "siteVersionId": str(site.version_id),
                "siteVersionNumber": site.version_number,
            }
        ),
        "metadata/pages.json": canonical_json_bytes(
            [
                {
                    "slug": page.slug,
                    "navigationLabel": page.navigation_label,
                    "home": page.is_home,
                    "resourceId": str(page.resource_id),
                    "resourceVersionId": str(page.resource_version_id),
                    "resourceVersionNumber": page.resource_version_number,
                    "kind": page.resource_kind,
                    "title": page.resource_title,
                    "abstract": page.resource_abstract,
                    "language": page.resource_language,
                    "license": page.resource_license,
                    "attribution": page.resource_attribution,
                    "content": page.resource_content,
                }
                for page in site.pages
            ]
        ),
        "lineage/resources.json": canonical_json_bytes(
            [
                {
                    "resourceId": str(reference.resource_id),
                    "resourceVersionId": str(reference.version_id),
                    "resourceVersionNumber": reference.version_number,
                    "kind": reference.kind,
                    "title": reference.title,
                }
                for reference in publication.references
            ]
        ),
        "lineage/assets.json": canonical_json_bytes(
            [
                {
                    "kind": asset.kind,
                    "datasetId": str(asset.dataset_id),
                    "datasetVersionId": str(asset.dataset_version_id),
                    "objectId": str(asset.object_id),
                    "contentType": asset.content_type,
                    "sizeBytes": asset.size_bytes,
                    "checksumSha256": asset.checksum_sha256,
                    "filename": asset.filename,
                }
                for asset in publication.assets
            ]
        ),
        "citations/index.json": canonical_json_bytes(_citations(site.pages)),
        "external-data-manifest.json": canonical_json_bytes(
            _external_dependencies(publication.references, public_project_root)
        ),
        "conversion-report.json": canonical_json_bytes(_conversion_report(publication)),
        "print/layout.json": canonical_json_bytes(site.print_layout),
    }
    for resource_id, content in images.items():
        files[f"assets/maps/{resource_id}.png"] = content
        files[f"print/maps/{resource_id}.svg"] = build_map_sheet_svg(
            publication, reference_by_id[resource_id], content
        )
    for object_id, content in assets.items():
        files[asset_urls[object_id]] = content
    files.update(document_visual_files)
    for page in site.pages:
        files[page_urls[page.slug]] = render_page_html(
            publication,
            page,
            page_urls=page_urls,
            css_url="assets/site.css",
            js_url="assets/site.js",
            public_project_root=public_project_root,
            snapshot_urls=snapshot_urls,
            asset_urls=asset_urls,
            document_previews=document_previews,
            document_visual_urls=document_visual_urls,
        )
    checksums = "".join(f"{_sha256(content)}  {path}\n" for path, content in sorted(files.items()))
    files["checksums.sha256"] = checksums.encode("utf-8")
    stream = BytesIO()
    with ZipFile(stream, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path, content in sorted(files.items()):
            info = ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    return stream.getvalue()


def render_content_blocks(
    resource_id: UUID,
    resource_kind: str,
    resource_abstract: str | None,
    resource_content: dict[str, Any],
    references: Mapping[UUID, ResourceReferenceView],
    assets: dict[UUID, PublishedSiteAsset],
    public_project_root: str,
    snapshot_urls: dict[UUID, str],
    asset_urls: dict[UUID, str],
    document_previews: dict[UUID, dict[str, Any]],
    document_visual_urls: dict[UUID, dict[int, str]],
    preview_assets: dict[UUID, SiteAssetCandidate] | None = None,
) -> str:
    rendered: list[str] = []
    if resource_abstract:
        rendered.append(f'<p class="standfirst">{escape(resource_abstract)}</p>')
    if resource_kind == "map":
        reference = references.get(resource_id)
        rendered.append(
            _render_map(
                reference,
                None,
                public_project_root,
                snapshot_urls.get(resource_id),
            )
        )
    blocks = resource_content.get("blocks")
    if not isinstance(blocks, list):
        return "".join(rendered)
    tables = {
        str(block.get("id")): block
        for block in blocks
        if isinstance(block, dict)
        and block.get("type") == "table"
        and isinstance(block.get("id"), str)
    }
    headings = _structural_headings(blocks)
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "markdown" and isinstance(block.get("markdown"), str):
            rendered.append(_safe_markdown(block["markdown"]))
        elif kind == "heading":
            rendered.append(_render_structural_heading(block, headings))
        elif kind == "callout":
            rendered.append(_render_callout(block))
        elif kind == "navigation":
            rendered.append(_render_page_navigation(block, headings))
        elif kind in {"map", "dataset"}:
            try:
                reference = references.get(UUID(str(block.get("resource_id"))))
            except (TypeError, ValueError):
                reference = None
            caption = block.get("caption") if isinstance(block.get("caption"), str) else None
            if kind == "map":
                rendered.append(
                    _render_map(
                        reference,
                        caption,
                        public_project_root,
                        snapshot_urls.get(reference.resource_id) if reference else None,
                    )
                )
            else:
                rendered.append(
                    _resource_card(
                        reference,
                        caption,
                        snapshot_urls.get(reference.resource_id) if reference else None,
                    )
                )
        elif kind == "link" and isinstance(block.get("url"), str):
            raw_label = block.get("label")
            label = raw_label if isinstance(raw_label, str) else cast(str, block["url"])
            if _is_safe_public_url(block["url"]):
                rendered.append(
                    '<p class="resource-card"><a rel="noopener noreferrer" href="{}">{}</a></p>'.format(
                        escape(block["url"], quote=True), escape(label)
                    )
                )
            else:
                rendered.append(
                    f'<p class="resource-card"><strong>{escape(label)}</strong> '
                    '<span class="fallback">Unsafe external link omitted.</span></p>'
                )
        elif kind == "citation":
            rendered.append(_citation(block))
        elif kind == "table":
            rendered.append(_render_table(block))
        elif kind == "chart":
            rendered.append(_render_chart(block, tables))
        elif kind in {"image", "file"}:
            try:
                object_id = UUID(str(block.get("object_id")))
            except (TypeError, ValueError):
                object_id = UUID(int=0)
            asset = assets.get(object_id)
            url = asset_urls.get(object_id)
            candidate = (preview_assets or {}).get(object_id)
            if asset is None and candidate is not None:
                rendered.append(_render_preview_asset(block, candidate))
            else:
                rendered.append(
                    _render_asset(block, asset, url, cast(Literal["image", "file"], kind))
                )
        elif kind == "document":
            try:
                object_id = UUID(str(block.get("object_id")))
            except (TypeError, ValueError):
                object_id = UUID(int=0)
            candidate = (preview_assets or {}).get(object_id)
            if assets.get(object_id) is None and candidate is not None:
                rendered.append(_render_preview_asset(block, candidate))
            else:
                rendered.append(
                    _render_document(
                        block,
                        assets.get(object_id),
                        document_previews.get(object_id),
                        document_visual_urls.get(object_id, {}),
                    )
                )
        elif kind == "preserved":
            raw_label = block.get("label")
            label = raw_label if isinstance(raw_label, str) else "Preserved content"
            rendered.append(
                f'<aside class="resource-card"><strong>{escape(label)}</strong><p class="fallback">This edition preserves an extension that requires its originating application for full presentation.</p></aside>'
            )
    return "".join(rendered)


def render_page_preview_html(
    *,
    resource_id: UUID,
    title: str,
    abstract: str | None,
    kind: str,
    content: dict[str, Any],
    references: Mapping[UUID, ResourceReferenceView],
    assets: dict[UUID, SiteAssetCandidate],
) -> bytes:
    body = render_content_blocks(
        resource_id=resource_id,
        resource_kind=kind,
        resource_abstract=abstract,
        resource_content=content,
        references=references,
        assets={},
        public_project_root="",
        snapshot_urls={},
        asset_urls={},
        document_previews={},
        document_visual_urls={},
        preview_assets=assets,
    )
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{PAGE_PREVIEW_CSP}">
<meta name="generator" content="{PAGE_RENDERER_VERSION}">
<title>{escape(title)} · OpenGeo preview</title>
<style>{SITE_CSS}</style>
</head>
<body data-renderer-version="{PAGE_RENDERER_VERSION}">
<main id="main-content"><article class="content">
<h1>{escape(title)}</h1>{body}
</article></main>
</body></html>"""
    return html.encode("utf-8")


def _safe_markdown(source: str) -> str:
    result: list[str] = []
    paragraph: list[str] = []
    list_items: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            result.append(f"<p>{'<br>'.join(paragraph)}</p>")
            paragraph.clear()

    def flush_list() -> None:
        if list_items:
            result.append("<ul>" + "".join(f"<li>{item}</li>" for item in list_items) + "</ul>")
            list_items.clear()

    for raw_line in source.splitlines():
        line = raw_line.rstrip()
        if not line:
            flush_paragraph()
            flush_list()
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1)) + 1
            result.append(f"<h{level}>{_inline_markdown(heading.group(2))}</h{level}>")
        elif line.startswith(("- ", "* ")):
            flush_paragraph()
            list_items.append(_inline_markdown(line[2:]))
        elif line.startswith("> "):
            flush_paragraph()
            flush_list()
            result.append(f"<blockquote>{_inline_markdown(line[2:])}</blockquote>")
        else:
            flush_list()
            paragraph.append(_inline_markdown(line))
    flush_paragraph()
    flush_list()
    return "".join(result)


def _inline_markdown(source: str) -> str:
    parts: list[str] = []
    cursor = 0
    for match in _MARKDOWN_LINK.finditer(source):
        parts.append(escape(source[cursor : match.start()]))
        parts.append(
            f'<a rel="noopener noreferrer" href="{escape(match.group(2), quote=True)}">{escape(match.group(1))}</a>'
        )
        cursor = match.end()
    parts.append(escape(source[cursor:]))
    return "".join(parts)


def _structural_headings(
    blocks: list[object],
) -> dict[str, tuple[int, str, int]]:
    headings: dict[str, tuple[int, str, int]] = {}
    previous_level: int | None = None
    invalid = False
    for position, block in enumerate(blocks):
        if not isinstance(block, dict) or block.get("type") != "heading":
            continue
        block_id = block.get("id")
        level = block.get("level")
        label = block.get("text")
        if (
            not isinstance(block_id, str)
            or _BLOCK_ID.fullmatch(block_id) is None
            or block_id in headings
            or not isinstance(level, int)
            or isinstance(level, bool)
            or level not in {2, 3, 4}
            or not isinstance(label, str)
            or not 1 <= len(label.strip()) <= 300
            or (previous_level is None and level != 2)
            or (previous_level is not None and level > previous_level + 1)
        ):
            invalid = True
            continue
        headings[block_id] = (level, label.strip(), position)
        previous_level = level
    return {} if invalid else headings


def _render_structural_heading(
    block: dict[str, object], headings: dict[str, tuple[int, str, int]]
) -> str:
    block_id = block.get("id")
    heading = headings.get(block_id) if isinstance(block_id, str) else None
    if heading is None:
        return '<aside class="resource-card"><strong>Heading unavailable</strong><p class="fallback">The stored heading did not satisfy the portable page structure contract.</p></aside>'
    level, label, _position = heading
    anchor = f"block-{block_id}"
    return (
        f'<h{level} id="{escape(anchor, quote=True)}" class="structural-heading">'
        f"{escape(label)}"
        f'<a class="heading-anchor" href="#{escape(anchor, quote=True)}" '
        f'aria-label="Link to {escape(label, quote=True)}">#</a></h{level}>'
    )


def _render_callout(block: dict[str, object]) -> str:
    tone = block.get("tone")
    title = block.get("title")
    markdown = block.get("markdown")
    if (
        tone not in {"note", "tip", "warning", "important"}
        or not isinstance(title, str)
        or not 1 <= len(title.strip()) <= 300
        or not isinstance(markdown, str)
        or not 1 <= len(markdown) <= 2_000
    ):
        return '<aside class="resource-card"><strong>Callout unavailable</strong><p class="fallback">The stored callout did not satisfy the portable callout contract.</p></aside>'
    return (
        f'<aside class="callout callout-{tone}" aria-label="{escape(title.strip(), quote=True)}">'
        f'<p class="callout-title">{escape(title.strip())}</p>{_safe_markdown(markdown)}</aside>'
    )


def _render_page_navigation(
    block: dict[str, object], headings: dict[str, tuple[int, str, int]]
) -> str:
    label = block.get("label")
    targets = block.get("heading_block_ids")
    if (
        not isinstance(label, str)
        or not 1 <= len(label.strip()) <= 300
        or not isinstance(targets, list)
        or not 1 <= len(targets) <= 12
        or not all(isinstance(target, str) and target in headings for target in targets)
        or len(set(targets)) != len(targets)
        or [headings[target][2] for target in targets]
        != sorted(headings[target][2] for target in targets)
    ):
        return '<aside class="resource-card"><strong>Page navigation unavailable</strong><p class="fallback">The stored navigation did not target this page\'s structural headings in document order.</p></aside>'
    items = "".join(
        f'<li><a href="#block-{escape(target, quote=True)}">{escape(headings[target][1])}</a></li>'
        for target in targets
    )
    return (
        f'<nav class="page-navigation" aria-label="{escape(label.strip(), quote=True)}">'
        f"<p>{escape(label.strip())}</p><ol>{items}</ol></nav>"
    )


def _render_map(
    reference: ResourceReferenceView | None,
    caption: str | None,
    public_project_root: str,
    snapshot_url: str | None,
) -> str:
    title = reference.title if reference is not None else "Map"
    description = caption or (reference.abstract if reference is not None else None)
    fallback = escape(description or f"Interactive map for {title}")
    if reference is None:
        return f'<figure class="map-embed"><figcaption><strong>{escape(title)}</strong></figcaption><p class="fallback">{fallback}. No public OGC map endpoint was sealed into this edition; consult the packaged resource lineage.</p></figure>'
    static_attributes = (
        f' src="{escape(snapshot_url, quote=True)}" data-static-src="{escape(snapshot_url, quote=True)}"'
        if snapshot_url is not None
        else ""
    )
    credits = [reference.attribution] if reference.attribution else []
    saved_map = getattr(reference.snapshot, "saved_map", None)
    if isinstance(saved_map, dict):
        for source in saved_map.get("sources", []):
            if isinstance(source, dict) and isinstance(source.get("attribution"), str):
                credit = source["attribution"]
                if isinstance(source.get("license"), str):
                    credit += f" ({source['license']})"
                if credit not in credits:
                    credits.append(credit)
    attribution = f'<p class="map-attribution">{escape(" · ".join(credits))}</p>' if credits else ""
    if reference.wms_service_id is None or reference.wms_layer_name is None:
        if snapshot_url is None:
            return f'<figure class="map-embed"><figcaption><strong>{escape(title)}</strong></figcaption><p class="fallback">{fallback}. No public OGC map endpoint or immutable PNG snapshot was sealed into this edition; consult the packaged resource lineage.</p></figure>'
        return f'<figure class="map-embed"><figcaption><strong>{escape(title)}</strong></figcaption><img alt="{fallback}" width="{reference.snapshot.width if reference.snapshot else 960}" height="{reference.snapshot.height if reference.snapshot else 540}"{static_attributes}><p class="interactive-note">This image preserves the map revision selected for this edition.</p>{attribution}</figure>'
    service_url = f"{public_project_root.rstrip('/')}/wms/{reference.wms_service_id}"
    capabilities = (
        service_url
        + "?"
        + urlencode({"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetCapabilities"})
    )
    return f"""<figure class="map-embed" data-wms-url="{escape(service_url, quote=True)}" data-layer="{escape(reference.wms_layer_name, quote=True)}">
<figcaption><strong>{escape(title)}</strong></figcaption>
<img alt="{fallback}" width="960" height="540"{static_attributes}>
<div class="map-controls" aria-label="Map zoom controls"><button type="button" data-map-zoom-in aria-label="Zoom in">+</button><button type="button" data-map-zoom-out aria-label="Zoom out">-</button><button type="button" data-map-reset>Reset</button></div>
<p class="interactive-note">This standards-based map reads the edition's revocable WMS endpoint. <a href="{escape(capabilities, quote=True)}">Service capabilities</a></p>{attribution}
<noscript><p class="fallback">{fallback}. JavaScript is disabled; use the linked WMS capabilities or the packaged lineage record.</p></noscript>
</figure>"""


def _resource_card(
    reference: ResourceReferenceView | None,
    caption: str | None,
    snapshot_url: str | None = None,
) -> str:
    if reference is None:
        return '<aside class="resource-card"><strong>Referenced dataset</strong><p class="fallback">The exact reference is recorded in the edition manifest.</p></aside>'
    description = caption or reference.abstract or "Governed dataset referenced by this page."
    rights = f"<p>License: {escape(reference.license)}</p>" if reference.license else ""
    preview = ""
    if reference.snapshot is not None and snapshot_url is not None:
        alternative = (
            caption or reference.abstract or f"Published dataset preview for {reference.title}"
        )
        # Keep the exact styled PNG: WMS enhancement would replace it with a live default style.
        preview = (
            '<figure class="content-image dataset-preview">'
            f'<img src="{escape(snapshot_url, quote=True)}" alt="{escape(alternative, quote=True)}" '
            f'width="{reference.snapshot.width}" height="{reference.snapshot.height}">'
            "<figcaption>Dataset preview from this published edition</figcaption></figure>"
        )
    return f'<aside class="resource-card"><strong>{escape(reference.title)}</strong><p>{escape(description)}</p>{preview}{rights}<p class="fallback">Resource {reference.resource_id}, immutable version {reference.version_number}</p></aside>'


def _citation(block: dict[str, object]) -> str:
    title = escape(str(block.get("title", "Citation")))
    locator = block.get("url")
    if not isinstance(locator, str) and isinstance(block.get("doi"), str):
        locator = f"https://doi.org/{block['doi']}"
    if isinstance(locator, str) and _is_safe_public_url(locator):
        return f'<p class="citation"><cite>{title}</cite>. <a rel="noopener noreferrer" href="{escape(locator, quote=True)}">Source</a></p>'
    return f'<p class="citation"><cite>{title}</cite></p>'


def _render_table(block: dict[str, object]) -> str:
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
    ):
        return '<aside class="resource-card"><strong>Table unavailable</strong><p class="fallback">The stored table did not satisfy the portable table contract.</p></aside>'
    headings = "".join(f'<th scope="col">{escape(column)}</th>' for column in columns)
    rendered_rows: list[str] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            return '<aside class="resource-card"><strong>Table unavailable</strong><p class="fallback">The stored table did not satisfy the portable table contract.</p></aside>'
        rendered_rows.append(
            "<tr>" + "".join(f"<td>{escape(_table_cell(cell))}</td>" for cell in row) + "</tr>"
        )
    body = (
        "".join(rendered_rows)
        or f'<tr><td colspan="{len(columns)}" class="fallback">No rows</td></tr>'
    )
    return f'<figure class="data-table"><table><caption>{escape(caption)}</caption><thead><tr>{headings}</tr></thead><tbody>{body}</tbody></table></figure>'


def _render_chart(block: dict[str, object], tables: dict[str, dict[str, object]]) -> str:
    title = block.get("title")
    alt_text = block.get("alt_text")
    table_id = block.get("table_block_id")
    chart_type = block.get("chart_type")
    x_column = block.get("x_column")
    y_columns = block.get("y_columns")
    table = tables.get(table_id) if isinstance(table_id, str) else None
    data = _chart_data(table, x_column, y_columns)
    if (
        not isinstance(title, str)
        or not isinstance(alt_text, str)
        or chart_type not in {"bar", "line"}
        or data is None
    ):
        label = escape(title) if isinstance(title, str) else "Chart unavailable"
        return f'<aside class="resource-card"><strong>{label}</strong><p class="fallback">The stored chart did not satisfy the portable chart contract; use its source table.</p></aside>'
    labels, series_names, series = data
    minimum = min(0.0, *(value for values in series for value in values if value is not None))
    maximum = max(0.0, *(value for values in series for value in values if value is not None))
    if math.isclose(minimum, maximum):
        maximum = minimum + 1.0
    left, top, width, height = 70.0, 35.0, 610.0, 245.0

    def y(value: float) -> float:
        return top + (maximum - value) * height / (maximum - minimum)

    colors = ("#176b87", "#a33b20", "#27764c", "#7650a8")
    shapes: list[str] = [
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{top + height}" stroke="#667085"/>',
        f'<line x1="{left}" y1="{y(0)}" x2="{left + width}" y2="{y(0)}" stroke="#667085"/>',
        f'<text x="{left - 8}" y="{top + 5}" text-anchor="end" font-size="11">{escape(_number(maximum))}</text>',
        f'<text x="{left - 8}" y="{top + height}" text-anchor="end" font-size="11">{escape(_number(minimum))}</text>',
    ]
    group = width / max(1, len(labels))
    if chart_type == "bar":
        bar_width = group * 0.76 / len(series)
        for series_index, values in enumerate(series):
            for index, value in enumerate(values):
                if value is None:
                    continue
                zero = y(0)
                value_y = y(value)
                shapes.append(
                    f'<rect x="{left + index * group + group * 0.12 + series_index * bar_width:.3f}" y="{min(zero, value_y):.3f}" width="{bar_width:.3f}" height="{max(1.0, abs(zero - value_y)):.3f}" fill="{colors[series_index]}"/>'
                )
    else:
        for series_index, values in enumerate(series):
            points = [
                (left + (index + 0.5) * group, y(value))
                for index, value in enumerate(values)
                if value is not None
            ]
            if points:
                encoded = " ".join(f"{x_value:.3f},{y_value:.3f}" for x_value, y_value in points)
                shapes.append(
                    f'<polyline points="{encoded}" fill="none" stroke="{colors[series_index]}" stroke-width="3"/>'
                )
                shapes.extend(
                    f'<circle cx="{x_value:.3f}" cy="{y_value:.3f}" r="3" fill="{colors[series_index]}"/>'
                    for x_value, y_value in points
                )
    label_step = max(1, math.ceil(len(labels) / 10))
    for index, label in enumerate(labels):
        if index % label_step == 0:
            shapes.append(
                f'<text x="{left + (index + 0.5) * group:.3f}" y="{top + height + 18}" text-anchor="middle" font-size="10">{escape(label[:24])}</text>'
            )
    for index, name in enumerate(series_names):
        legend_x = left + index * 145
        shapes.append(
            f'<rect x="{legend_x}" y="325" width="12" height="12" fill="{colors[index]}"/><text x="{legend_x + 18}" y="336" font-size="11">{escape(name[:20])}</text>'
        )
    svg = "".join(shapes)
    return f'<figure class="chart-block"><figcaption>{escape(title)}</figcaption><svg viewBox="0 0 720 360" role="img" aria-label="{escape(alt_text, quote=True)}"><title>{escape(alt_text)}</title>{svg}</svg><p class="chart-description">{escape(alt_text)}</p></figure>'


def _render_asset(
    block: dict[str, object],
    asset: PublishedSiteAsset | None,
    url: str | None,
    kind: Literal["image", "file"],
) -> str:
    if asset is None or asset.kind != kind or url is None:
        return '<aside class="resource-card"><strong>Published asset unavailable</strong><p class="fallback">The exact governed asset was not sealed into this edition.</p></aside>'
    encoded_url = escape(url, quote=True)
    if kind == "image":
        alt_text = block.get("alt_text")
        caption = block.get("caption")
        if not isinstance(alt_text, str):
            return '<aside class="resource-card"><strong>Published image unavailable</strong><p class="fallback">The stored image has no valid text alternative.</p></aside>'
        figcaption = (
            f"<figcaption>{escape(caption)}</figcaption>" if isinstance(caption, str) else ""
        )
        return f'<figure class="content-image">{figcaption}<img src="{encoded_url}" alt="{escape(alt_text, quote=True)}" loading="lazy"><p class="fallback">Immutable asset {asset.object_id}; SHA-256 {asset.checksum_sha256}.</p></figure>'
    label = block.get("label")
    description = block.get("description")
    if not isinstance(label, str):
        label = asset.filename
    detail = (
        f'<p class="file-description">{escape(description)}</p>'
        if isinstance(description, str)
        else ""
    )
    return f'<aside class="resource-card"><a href="{encoded_url}" download="{escape(asset.filename, quote=True)}">{escape(label)}</a>{detail}<p class="fallback">{escape(asset.content_type)} · {asset.size_bytes} bytes · SHA-256 {asset.checksum_sha256}</p></aside>'


def _render_preview_asset(block: dict[str, object], asset: SiteAssetCandidate) -> str:
    if block.get("type") != asset.kind:
        return '<aside class="resource-card"><strong>Governed asset unavailable</strong><p class="fallback">The draft asset kind does not match the authorized exact object.</p></aside>'
    identity = (
        f"{escape(asset.content_type)} · {asset.size_bytes} bytes · SHA-256 {asset.checksum_sha256}"
    )
    if asset.kind == "image":
        alt_text = block.get("alt_text")
        caption = block.get("caption")
        if not isinstance(alt_text, str):
            return '<aside class="resource-card"><strong>Governed image unavailable</strong><p class="fallback">The draft image has no valid text alternative.</p></aside>'
        figcaption = (
            f"<figcaption>{escape(caption)}</figcaption>" if isinstance(caption, str) else ""
        )
        return (
            f'<figure class="content-image">{figcaption}'
            f'<div role="img" aria-label="{escape(alt_text, quote=True)}" class="resource-card">'
            f"Exact governed image {asset.object_id}. Image bytes are displayed only from a "
            "sealed publication URL.</div>"
            f'<p class="fallback">{identity}</p></figure>'
        )
    label = block.get("label")
    if not isinstance(label, str):
        label = asset.filename
    description = block.get("description")
    detail = f"<p>{escape(description)}</p>" if isinstance(description, str) else ""
    noun = "document" if asset.kind == "document" else "file"
    return (
        f'<aside class="resource-card"><strong>{escape(label)}</strong>{detail}'
        f"<p>Exact governed {noun} {asset.object_id}. Download or document bytes are "
        "served only from a sealed publication URL.</p>"
        f'<p class="fallback">{identity}</p></aside>'
    )


def _render_document(
    block: dict[str, object],
    asset: PublishedSiteAsset | None,
    preview: dict[str, Any] | None,
    visual_urls: dict[int, str],
) -> str:
    if asset is None or asset.kind != "document" or preview is None:
        return '<aside class="resource-card"><strong>Published document unavailable</strong><p class="fallback">The exact governed semantic preview was not sealed into this edition.</p></aside>'
    label = block.get("label")
    if not isinstance(label, str):
        return '<aside class="resource-card"><strong>Published document unavailable</strong><p class="fallback">The document block has no valid heading.</p></aside>'
    block_id = block.get("id") if isinstance(block.get("id"), str) else str(asset.object_id)
    heading_id = f"document-{block_id}"
    title = preview.get("title")
    language = preview.get("language")
    pages = preview.get("pages")
    source_format = preview.get("sourceFormat")
    if not isinstance(pages, list):
        return '<aside class="resource-card"><strong>Published document unavailable</strong><p class="fallback">The governed semantic preview is invalid.</p></aside>'
    title_html = (
        f'<p class="document-title">Source title: {escape(title)}</p>'
        if isinstance(title, str)
        else ""
    )
    page_html: list[str] = []
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("number"), int):
            continue
        number = cast(int, page["number"])
        raw_blocks = page.get("blocks")
        if not isinstance(raw_blocks, list):
            continue
        content: list[str] = []
        for document_block in raw_blocks:
            if not isinstance(document_block, dict):
                continue
            kind = document_block.get("type")
            if kind == "heading" and isinstance(document_block.get("text"), str):
                source_level = document_block.get("level")
                if not isinstance(source_level, int) or isinstance(source_level, bool):
                    continue
                level = min(6, source_level + 2)
                content.append(
                    f'<h{level} data-source-heading-level="{source_level}">{escape(cast(str, document_block["text"]))}</h{level}>'
                )
            elif kind == "paragraph" and isinstance(document_block.get("text"), str):
                content.append(f"<p>{escape(cast(str, document_block['text']))}</p>")
            elif kind == "list" and isinstance(document_block.get("items"), list):
                tag = "ol" if document_block.get("ordered") is True else "ul"
                items = "".join(
                    f"<li>{escape(item)}</li>"
                    for item in cast(list[object], document_block["items"])
                    if isinstance(item, str)
                )
                content.append(f"<{tag}>{items}</{tag}>")
            elif kind == "table":
                content.append(_render_document_table(document_block))
        has_semantic_content = bool(content)
        text_source = page.get("textSource")
        visual_url = visual_urls.get(number)
        if visual_url is not None:
            width = page.get("width")
            height = page.get("height")
            if isinstance(width, int) and isinstance(height, int):
                alt = (
                    ""
                    if has_semantic_content
                    else (
                        f"Visual rendering of PDF page {number}; OCR found no text."
                        if text_source == "ocr"
                        else (
                            f"Visual rendering of PDF page {number}; the bounded OCR page limit was reached."
                            if text_source == "none"
                            else f"Visual rendering of PDF page {number}; no text was extractable and OCR was not performed."
                        )
                    )
                )
                content.insert(
                    0,
                    '<figure class="document-page-visual">'
                    f'<img src="{escape(visual_url, quote=True)}" alt="{escape(alt, quote=True)}" '
                    f'width="{width}" height="{height}" loading="lazy">'
                    f"<figcaption>Bounded visual rendering of source page {number}.</figcaption>"
                    "</figure>",
                )
        if source_format == "pdf" and not has_semantic_content:
            if text_source == "ocr":
                empty_message = "OCR was attempted on this page but found no text."
            elif text_source == "none":
                empty_message = (
                    "No text was extracted because the bounded OCR page limit was reached."
                )
            else:
                empty_message = "No extractable text was found on this page; OCR was not performed."
            content.append(f'<p class="document-empty">{empty_message}</p>')
        page_html.append(
            f'<section class="document-page" aria-label="Source document page {number}"><p class="document-page-label">Page {number}</p>{"".join(content)}</section>'
        )
    language_attribute = (
        f' lang="{escape(language, quote=True)}"' if isinstance(language, str) else ""
    )
    if source_format == "pdf":
        version = preview.get("pdfVersion")
        extraction = preview.get("extraction")
        if isinstance(extraction, dict) and extraction.get("ocrPerformed") is True:
            ocr_pages = cast(list[int], extraction["ocrPages"])
            ocr_note = (
                f"declared-language Tesseract OCR was attempted on {len(ocr_pages)} page(s) "
                f"using {escape(cast(str, extraction['ocrModel']))}; OCR may contain errors"
            )
            if extraction.get("ocrTruncated") is True:
                ocr_note += ", and the 32-page OCR limit was reached"
        else:
            ocr_note = "OCR was not performed"
        if preview.get("schemaVersion") in PDF_VISUAL_PRESENTATION_SCHEMAS:
            fidelity = (
                f"Sanitized bounded all-page visual and semantic presentation of PDF {escape(str(version))}; "
                f"visual pages are lossy raster derivatives, reading order is heuristic, {ocr_note}, "
                "and forms, annotations, links, and active content are not reproduced."
            )
        else:
            fidelity = (
                f"Sanitized all-page semantic text presentation of PDF {escape(str(version))}; "
                f"reading order is heuristic, {ocr_note}, and original visual layout, "
                "images, forms, annotations, and active content are not reproduced."
            )
    else:
        version = preview.get("odfVersion")
        fidelity = (
            f"Sanitized semantic preview of ODF Text {escape(str(version))}; original layout, "
            "images, tracked changes, annotations, and active or external content are not "
            "reproduced."
        )
    return (
        f'<section class="document-preview" aria-labelledby="{escape(heading_id, quote=True)}"{language_attribute}>'
        f'<header><h2 id="{escape(heading_id, quote=True)}">{escape(label)}</h2>{title_html}'
        f'<p class="document-fidelity">{fidelity}</p></header>'
        f'{"".join(page_html)}<p class="fallback">Immutable semantic asset {asset.object_id}; SHA-256 {asset.checksum_sha256}.</p></section>'
    )


def _render_document_table(block: dict[str, object]) -> str:
    rows = block.get("rows")
    header_rows = block.get("headerRows")
    if (
        not isinstance(rows, list)
        or not isinstance(header_rows, int)
        or isinstance(header_rows, bool)
    ):
        return ""
    caption = block.get("label")
    caption_html = f"<caption>{escape(caption)}</caption>" if isinstance(caption, str) else ""
    head: list[str] = []
    body: list[str] = []
    for index, row in enumerate(rows):
        if not isinstance(row, list):
            continue
        cell_tag = "th" if index < header_rows else "td"
        scope = ' scope="col"' if cell_tag == "th" else ""
        encoded = "".join(
            f"<{cell_tag}{scope}>{escape(cell)}</{cell_tag}>"
            for cell in row
            if isinstance(cell, str)
        )
        (head if index < header_rows else body).append(f"<tr>{encoded}</tr>")
    head_html = f"<thead>{''.join(head)}</thead>" if head else ""
    return (
        f'<div class="document-table"><table>{caption_html}{head_html}'
        f"<tbody>{''.join(body)}</tbody></table></div>"
    )


def _chart_data(
    table: dict[str, object] | None,
    x_column: object,
    y_columns: object,
) -> tuple[list[str], list[str], list[list[float | None]]] | None:
    if (
        table is None
        or not isinstance(x_column, str)
        or not isinstance(y_columns, list)
        or not 1 <= len(y_columns) <= 4
        or not all(isinstance(column, str) for column in y_columns)
    ):
        return None
    columns = table.get("columns")
    rows = table.get("rows")
    if not isinstance(columns, list) or not isinstance(rows, list):
        return None
    lookup = {str(column).casefold(): index for index, column in enumerate(columns)}
    x_index = lookup.get(x_column.casefold())
    y_indexes = [lookup.get(column.casefold()) for column in y_columns]
    if x_index is None or any(index is None for index in y_indexes):
        return None
    labels: list[str] = []
    series: list[list[float | None]] = [[] for _ in y_columns]
    for row in rows:
        if not isinstance(row, list) or len(row) != len(columns):
            return None
        labels.append(_table_cell(row[x_index]))
        for target, raw_index in zip(series, y_indexes, strict=True):
            if raw_index is None:
                return None
            value = row[raw_index]
            if value is None:
                target.append(None)
            elif isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            else:
                numeric = float(value)
                if not math.isfinite(numeric):
                    return None
                target.append(numeric)
    if not labels or any(not any(value is not None for value in values) for values in series):
        return None
    return labels, [str(column) for column in y_columns], series


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


def _is_safe_public_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return (
            parsed.scheme == "https"
            and parsed.hostname is not None
            and parsed.username is None
            and parsed.password is None
        )
    except ValueError:
        return False


def _citations(pages: tuple[SitePage, ...]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for page in pages:
        blocks = page.resource_content.get("blocks")
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "citation":
                result.append({"page": page.slug, **block})
    return result


def _external_dependencies(
    references: tuple[PublishedResourceReference, ...], public_project_root: str
) -> dict[str, object]:
    dependencies = []
    for reference in references:
        record: dict[str, object] = {
            "resourceId": str(reference.resource_id),
            "resourceVersionId": str(reference.version_id),
            "requiresNetwork": reference.wms_service_id is not None,
            "immutableSnapshotEmbedded": reference.snapshot is not None,
        }
        if reference.wms_service_id is not None and reference.wms_layer_name is not None:
            record.update(
                {
                    "standard": "OGC WMS 1.3.0",
                    "serviceUrl": (
                        f"{public_project_root.rstrip('/')}/wms/{reference.wms_service_id}"
                    ),
                    "layerName": reference.wms_layer_name,
                    "revocable": True,
                }
            )
        dependencies.append(record)
    return {"schemaVersion": "1.0.0", "dependencies": dependencies}


def _conversion_report(publication: PublishedSite) -> dict[str, object]:
    map_resources = _map_resource_ids(publication.site.pages)
    print_options = resolve_print_options(publication)
    positioned_pages = len(parse_print_layout(publication.site.print_layout).pages)
    warnings = [
        {
            "resourceId": str(reference.resource_id),
            "code": "static_map_snapshot_missing",
            "message": "No immutable PNG render was selected when this edition was sealed.",
        }
        for reference in publication.references
        if reference.resource_id in map_resources and reference.snapshot is None
    ]
    return {
        "schemaVersion": "1.0.0",
        "status": "complete" if not warnings else "complete_with_warnings",
        "warnings": warnings,
        "lossPolicy": "No content block is silently discarded; unsupported extensions remain visible as fallbacks.",
        "print": {
            "pageSize": print_options.page_size,
            "orientation": print_options.orientation,
            "layout": print_options.layout,
            "sourcePanel": print_options.legend,
            "northArrow": print_options.north_arrow,
            "scaleBar": print_options.scale_bar,
            "pdf": "request-driven",
            "wholePagePng": "request-driven-96-dpi",
            "positionedPages": positioned_pages,
            "selfContainedSvgMapSheets": sum(
                reference.snapshot is not None for reference in publication.references
            ),
        },
    }


def _map_resource_ids(pages: tuple[SitePage, ...]) -> set[UUID]:
    result = {page.resource_id for page in pages if page.resource_kind == "map"}
    for page in pages:
        blocks = page.resource_content.get("blocks")
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if not isinstance(block, dict) or block.get("type") != "map":
                continue
            try:
                result.add(UUID(str(block.get("resource_id"))))
            except (TypeError, ValueError):
                continue
    return result


def _sha256(value: bytes) -> str:
    from hashlib import sha256

    return sha256(value).hexdigest()


def _number(value: float) -> str:
    return f"{value:.8f}".rstrip("0").rstrip(".")
