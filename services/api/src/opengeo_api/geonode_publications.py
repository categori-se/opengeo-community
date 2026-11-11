"""Offline conversion of the pinned MapStore GeoStory title/text profile.

Source definitions remain in the ordinary GeoNode metadata custody extension.
This module never fetches a URL, executes HTML, or assigns publication authority.
"""

import json
import re
from html.parser import HTMLParser
from typing import Any

PROFILE = "geonode-5.1-mapstore-geostory-text.1"
MAX_DATA_BYTES = 65_536
MAX_BLOCKS = 22  # Leave space for the source link and preserved-definition marker.


def publication_data(value: Any) -> Any:
    """Decode GeoNode's object/string carrier without replacing its source bytes."""
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_DATA_BYTES:
            raise ValueError("GeoNode publication data exceeds 64 KiB")
        try:
            value = json.loads(value)
        except (ValueError, RecursionError) as error:
            raise ValueError("GeoNode publication data must contain valid JSON") from error
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > 20_000 or depth > 32:
            raise ValueError("GeoNode publication data exceeds its structural limits")
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    try:
        size = len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError, UnicodeError) as error:
        raise ValueError("GeoNode publication data must contain valid JSON") from error
    if size > MAX_DATA_BYTES:
        raise ValueError("GeoNode publication data exceeds 64 KiB")
    return value


class _StoryText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.losses: set[str] = set()
        self.suppressed: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "iframe", "object", "svg", "math"}:
            self.losses.add("active_or_embedded_html")
            self.suppressed.append(tag)
        if self.suppressed:
            return
        if tag in {"p", "div", "br"}:
            self.parts.append("\n")
        elif tag not in {"span", "a"}:
            self.losses.add("html_formatting")
        if any(name != "href" or tag != "a" for name, _ in attrs):
            self.losses.add("html_attributes")
        if tag == "a" and any(name == "href" for name, _ in attrs):
            self.losses.add("link_target")

    def handle_endtag(self, tag: str) -> None:
        if self.suppressed:
            if tag == self.suppressed[-1]:
                self.suppressed.pop()
            return
        if tag in {"p", "div"}:
            self.parts.append("\n\n")

    def handle_data(self, data: str) -> None:
        if not self.suppressed:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", "".join(self.parts)).strip()


def convert_publication(kind: str, value: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Convert supported native containers and report every unsupported element."""
    blocks: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "profile": PROFILE,
        "blocks": [],
        "losses": [],
        "normalizations": [],
        "offlineReady": False,
        "runtimeDependencies": [],
    }

    def loss(path: str, code: str, detail: str) -> None:
        report["losses"].append({"path": path, "code": code, "detail": detail})

    def add(path: str, block: dict[str, Any]) -> None:
        if len(blocks) >= MAX_BLOCKS:
            raise ValueError("GeoNode publication exceeds the 22 converted block limit")
        block_id = f"geonode-content-{len(blocks) + 1}"
        blocks.append({"id": block_id, **block})
        report["blocks"].append({"sourcePath": path, "blockId": block_id, "type": block["type"]})

    def visit(node: Any, path: str, *, section: bool = False) -> None:
        if not isinstance(node, dict):
            loss(path, "unsupported_node", "Expected a native GeoStory content object.")
            return
        node_type = node.get("type")
        allowed = {"title", "paragraph"} if section else {"column", "text"}
        if node_type not in allowed:
            loss(path, "unsupported_content", f"Preserved {node_type!s} without converting it.")
            return
        supported = {"id", "type", "contents"}
        if section:
            supported.add("title")
            title = node.get("title")
            if title is not None and not isinstance(title, str):
                loss(f"{path}.title", "invalid_title", "Section title must be text.")
            if isinstance(title, str) and title.strip():
                if len(title.strip()) > 300:
                    raise ValueError("GeoNode publication title exceeds 300 characters")
                add(f"{path}.title", {"type": "heading", "level": 2, "text": title.strip()})
                report["normalizations"].append(
                    {"path": f"{path}.title", "detail": "Section title becomes a visible heading."}
                )
        elif node_type == "column":
            supported |= {"size", "align"}
            if node.get("size", "full") != "full" or node.get("align", "center") != "center":
                loss(path, "column_layout", "Column placement becomes ordinary reading order.")
        elif node_type == "text":
            supported |= {"html", "background"}
            if node.get("background"):
                loss(f"{path}.background", "background", "Background retained in source only.")
            html = node.get("html")
            if not isinstance(html, str):
                loss(f"{path}.html", "missing_text", "Text content requires an HTML string.")
            else:
                parser = _StoryText()
                parser.feed(html)
                parser.close()
                text = parser.text()
                for code in sorted(parser.losses):
                    loss(f"{path}.html", code, "Text retained; unsupported HTML remains in source.")
                if len(text) > 8_000:
                    raise ValueError("GeoNode publication text exceeds 8000 characters")
                # HTML text is literal. Do not reinterpret its punctuation as
                # Markdown links, headings, lists or quotations in native output.
                markdown_syntax = re.search(
                    r"(?m)^(?:#{1,3}\s+|[-*] |> )|\[[^\]\n]{1,300}\]\(https://[^\s)]+\)",
                    text,
                )
                if markdown_syntax:
                    loss(
                        f"{path}.html",
                        "literal_markdown",
                        "Literal Markdown-like text remains in source to avoid reinterpretation.",
                    )
                elif text:
                    add(f"{path}.html", {"type": "markdown", "markdown": text})
                elif html.strip():
                    loss(f"{path}.html", "empty_text", "No readable text could be converted.")
        for key, item in node.items():
            if key not in supported and item not in (None, {}, []):
                loss(f"{path}.{key}", "unsupported_option", "Option retained in source only.")
        contents = node.get("contents", [])
        if not isinstance(contents, list):
            loss(f"{path}.contents", "invalid_contents", "Contents must be an ordered array.")
        else:
            for index, item in enumerate(contents):
                visit(item, f"{path}.contents[{index}]")

    data = publication_data(value)
    if kind != "story" or not isinstance(data, dict) or data.get("type") != "cascade":
        loss(
            "data",
            "unsupported_publication",
            "Only the native cascade title/text profile converts.",
        )
    elif not isinstance(data.get("sections"), list):
        loss("data.sections", "missing_sections", "Native GeoStory sections are required.")
    else:
        for key, item in data.items():
            if key not in {"type", "sections", "description"} and item not in (None, {}, []):
                loss(f"data.{key}", "unsupported_option", "Option retained in source only.")
        for index, section in enumerate(data["sections"]):
            visit(section, f"data.sections[{index}]", section=True)
    report["offlineReady"] = bool(blocks) and not report["losses"]
    return blocks, report
