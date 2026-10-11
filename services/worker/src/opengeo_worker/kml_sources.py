"""Inspect bounded KML source structure without resolving links or converting data."""

import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree

from opengeo_worker.models import ArtifactFile, InspectionResult, ValidationFailure

MAX_KML_SOURCE_BYTES = 4 * 1024 * 1024
MAX_KML_NODES = 20_000
MAX_KML_DEPTH = 32
_KML = "{http://www.opengis.net/kml/2.2}"
_COUNTED = (
    "Document",
    "Folder",
    "Placemark",
    "GroundOverlay",
    "ScreenOverlay",
    "PhotoOverlay",
    "NetworkLink",
    "Style",
    "StyleMap",
    "Schema",
)


def inspect_kml_source(source: Path) -> InspectionResult:
    if not 0 < source.stat().st_size <= MAX_KML_SOURCE_BYTES:
        raise ValidationFailure("kml_source_size_limit")
    with source.open("rb") as stream:
        raw = stream.read(MAX_KML_SOURCE_BYTES + 1)
    if len(raw) > MAX_KML_SOURCE_BYTES:
        raise ValidationFailure("kml_source_size_limit")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValidationFailure("kml_source_encoding_unsupported") from error
    # Restrict this first source-inspection contract to UTF-8, including declarations.
    encoding = re.search(r'<\?xml\b[^?]*\bencoding\s*=\s*[\'"]([^\'"]+)', text, re.I)
    if encoding and encoding.group(1).lower() not in {"utf-8", "utf8"}:
        raise ValidationFailure("kml_source_encoding_unsupported")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I):
        raise ValidationFailure("kml_source_entities_forbidden")
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise ValidationFailure("kml_source_xml_invalid") from error
    if root.tag != f"{_KML}kml":
        raise ValidationFailure("kml_source_namespace_unsupported")
    counts: Counter[str] = Counter()
    pending = [(root, 0)]
    node_count = 0
    while pending:
        node, depth = pending.pop()
        node_count += 1
        if node_count > MAX_KML_NODES or depth > MAX_KML_DEPTH:
            raise ValidationFailure("kml_source_structure_limit")
        if node.tag.startswith(_KML) and node.tag[len(_KML) :] in _COUNTED:
            counts[node.tag[len(_KML) :]] += 1
        pending.extend((child, depth + 1) for child in node)
    result = InspectionResult(
        feature_count=None,
        extent=None,
        crs=None,
        geometry_type=None,
        schema_definition={
            "fields": [],
            "kml_source": {
                "schema_version": "opengeo.kml-source-inspection.1.0.0",
                "source_format": "kml",
                "namespace": "http://www.opengis.net/kml/2.2",
                "encoding": "utf-8",
                "source_sha256": hashlib.sha256(raw).hexdigest(),
                "source_bytes": len(raw),
                "element_counts": {name: counts[name] for name in _COUNTED},
                "inspection_method": "bounded_xml_structure",
                "geometry_inspected": False,
                "links_resolved": False,
                "license": None,
            },
        },
        quality_results={
            "source_preservation": {"original_unchanged": True, "derived_artifacts": 1},
            "kml_inspection": {
                "status": "structure_only",
                "geometry_status": "not_inspected",
                "rendering_status": "not_established",
                "network_links": "not_fetched",
            },
        },
        artifacts=(),
    )

    report = source.with_name(f"{source.name}.inspection.json")
    report.write_text(
        json.dumps(result.schema_definition, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return InspectionResult(
        feature_count=result.feature_count,
        extent=result.extent,
        crs=result.crs,
        geometry_type=result.geometry_type,
        schema_definition=result.schema_definition,
        quality_results=result.quality_results,
        artifacts=(
            ArtifactFile(
                role="derived",
                relative_key="kml-source-inspection.json",
                content_type="application/json",
                path=report,
            ),
        ),
    )
