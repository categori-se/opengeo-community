import copy
import json
from hashlib import sha256

import pytest

from opengeo_api.json_canonical import canonical_json_bytes
from opengeo_api.project_module import (
    NativePayloadUnsupported,
    native_payload,
    native_project_module,
)


def image_id(symbol):
    return f"opengeo-point-{symbol}-v1"


def payload(symbol="hospital"):
    return {
        "title": "Care facilities",
        "mode": "offline",
        "view": {"center": [85, 27], "zoom": 4, "pitch": 0, "bearing": 0},
        "style": {
            "version": 8,
            "sources": {
                "health": {
                    "type": "geojson",
                    "data": {
                        "type": "FeatureCollection",
                        "features": [
                            {
                                "type": "Feature",
                                "id": "hospital",
                                "properties": {"kind": "Hospital"},
                                "geometry": {"type": "Point", "coordinates": [85, 27]},
                            }
                        ],
                    },
                }
            },
            "layers": [
                {
                    "id": "health-icon",
                    "type": "symbol",
                    "source": "health",
                    "layout": {
                        "icon-image": image_id(symbol),
                        "icon-size": 0.5,
                        "icon-allow-overlap": True,
                        "icon-ignore-placement": True,
                        "visibility": "visible",
                    },
                    "paint": {"icon-opacity": 0.4},
                }
            ],
        },
        "controls": [{"title": "Care facilities", "ids": ["health-icon"], "visible": True}],
        "images": [
            {
                "id": image_id(symbol),
                "width": 64,
                "height": 64,
                "data": [0] * 16384,
                "pixelRatio": 2,
            }
        ],
    }


def artifact(value):
    html = (
        "<!doctype html><script>const publication="
        + json.dumps(value, separators=(",", ":"))
        + ";\nconst status=document.getElementById('status');</script>"
    ).encode()
    checksum = sha256(html).hexdigest()
    manifest = {
        "schemaVersion": "opengeo.project-artifact.1.0.0",
        "representation": "portable-map-html",
        "canonicalization": "opengeo-codepoint-decimal-v1",
        "artifactId": f"sha256:{checksum}",
        "project": None,
        "output": {
            "objectId": None,
            "mediaType": "text/html",
            "sizeBytes": len(html),
            "checksumSha256": checksum,
        },
        "dependencies": [
            {
                "id": "health",
                "mode": "embedded",
                "checksumSha256": sha256(
                    canonical_json_bytes(value["style"]["sources"]["health"])
                ).hexdigest(),
            }
        ],
        "build": {
            "inputScope": "reviewed-browser-snapshot",
            "runtime": {},
            "inputChecksumSha256": sha256(
                canonical_json_bytes({"payload": value, "runtime": {}})
            ).hexdigest(),
        },
    }
    manifest["manifestChecksumSha256"] = sha256(canonical_json_bytes(manifest)).hexdigest()
    return html, manifest


def test_known_local_point_images_are_admitted_with_exact_bound_pixels_and_opacity():
    for symbol in ("circle", "hospital", "clinic", "school", "star", "flag"):
        value = payload(symbol)
        value["images"][0]["data"][3] = 127
        assert native_payload(*artifact(value)) == value


def test_bounded_category_symbols_keep_string_categories_and_all_fallback_assets():
    value = payload()
    expression = ["match", ["to-string", ["get", "kind"]]]
    for index in range(48):
        expression.extend((f"Category {index}", image_id("hospital" if index % 2 else "clinic")))
    expression.append(image_id("circle"))
    value["style"]["layers"][0]["layout"]["icon-image"] = expression
    for symbol in ("clinic", "circle"):
        value["images"].append({**value["images"][0], "id": image_id(symbol)})
    assert native_payload(*artifact(value))["images"] == value["images"]
    module = native_project_module(value, {"title": "Care facilities"})
    assert module.index(b"map.addImage(image.id") < module.index(b"map.addLayer(")
    assert b"new Uint8Array(image.data)" in module and b"iframe.src" not in module


def test_native_icons_reject_external_unknown_and_executable_asset_expressions():
    for expression in (
        "https://private.example/icon.png?token=secret",
        "unbound-sprite-icon",
        ["get", "image_url"],
        ["image", image_id("hospital")],
        ["match", ["get", "kind"], "Hospital", image_id("hospital"), image_id("circle")],
        ["match", ["to-string", ["get", "kind"]], "Hospital", "unknown", image_id("circle")],
        [
            "match",
            ["to-string", ["get", "kind"]],
            "Hospital",
            image_id("hospital"),
            "Hospital",
            image_id("clinic"),
            image_id("circle"),
        ],
    ):
        value = payload()
        value["style"]["layers"][0]["layout"]["icon-image"] = expression
        with pytest.raises(NativePayloadUnsupported, match="unsupported_point_symbol_assets"):
            native_payload(*artifact(value))


def test_native_icon_layout_size_opacity_and_expression_caps_are_closed():
    for key, replacement in (
        ("icon-size", 0),
        ("icon-size", 1.51),
        ("icon-size", True),
        ("icon-allow-overlap", False),
        ("icon-ignore-placement", False),
        ("text-field", "External label"),
        ("icon-offset", [0, 1]),
    ):
        value = payload()
        value["style"]["layers"][0]["layout"][key] = replacement
        with pytest.raises(NativePayloadUnsupported):
            native_payload(*artifact(value))
    for replacement in (-0.1, 1.1, True, "1"):
        value = payload()
        value["style"]["layers"][0]["paint"]["icon-opacity"] = replacement
        with pytest.raises(NativePayloadUnsupported):
            native_payload(*artifact(value))
    value = payload()
    value["style"]["layers"][0]["layout"]["icon-image"] = [
        "match",
        ["to-string", ["get", "kind"]],
        *[part for index in range(49) for part in (str(index), image_id("hospital"))],
        image_id("hospital"),
    ]
    with pytest.raises(NativePayloadUnsupported):
        native_payload(*artifact(value))


def test_missing_or_malformed_point_pixels_are_rejected_before_native_delivery():
    for change in ("missing", "short", "ratio", "size", "byte", "duplicate"):
        value = payload()
        if change == "missing":
            value["images"].clear()
        elif change == "short":
            value["images"][0]["data"].pop()
        elif change == "ratio":
            value["images"][0]["pixelRatio"] = 3
        elif change == "size":
            value["images"][0]["width"] = 128
        elif change == "byte":
            value["images"][0]["data"][0] = 256
        else:
            value["images"].append(copy.deepcopy(value["images"][0]))
        with pytest.raises(NativePayloadUnsupported):
            native_payload(*artifact(value))


def test_existing_text_patterns_and_output_binding_remain_enforced():
    value = payload()
    value["style"]["layers"][0] = {
        "id": "health-icon",
        "type": "symbol",
        "source": "health",
        "layout": {"text-field": ["get", "kind"]},
    }
    value["images"][0]["id"] = "retained-pattern"
    assert native_payload(*artifact(value)) == value
    value = payload()
    html, manifest = artifact(value)
    with pytest.raises(NativePayloadUnsupported):
        native_payload(html + b"!", manifest)
    changed = copy.deepcopy(value)
    changed["images"][0]["data"][0] = 127
    changed_html, changed_manifest = artifact(changed)
    changed_manifest["build"] = manifest["build"]
    changed_manifest["manifestChecksumSha256"] = sha256(
        canonical_json_bytes(
            {key: item for key, item in changed_manifest.items() if key != "manifestChecksumSha256"}
        )
    ).hexdigest()
    with pytest.raises(NativePayloadUnsupported, match="compiler_input_binding_mismatch"):
        native_payload(changed_html, changed_manifest)
