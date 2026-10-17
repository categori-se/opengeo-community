"""Real API compiler -> fixed GL worker proof with explicitly provisioned local inputs.

Set PYTHONPATH to the API and worker src directories. Supply a trusted, SHA-pinned
runtime manifest and font root; this command never discovers/downloads packages,
calls a database/cloud service, or claims Studio/deployed acceptance.
"""

import argparse
import json
import time
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from opengeo_api.map_definitions import MAP_DEFINITION_SCHEMA_VERSION
from opengeo_api.render_runtime import RenderRuntimeReference
from opengeo_api.resources import ResourceStyle
from opengeo_api.saved_map_jobs import saved_view_bbox
from opengeo_api.saved_map_render_passes import SavedMapStyleIdentity, compile_saved_map_passes
from opengeo_api.saved_map_rendering import compile_saved_map

from opengeo_worker.maplibre_renderer import DispatchingMapRenderer, MapLibreCompositionRenderer
from opengeo_worker.maplibre_runtime import MapLibreRuntime
from opengeo_worker.models import ObjectReference, RenderClaim, RenderLayerClaim


def identifier(prefix: str, number: int) -> UUID:
    return UUID(f"{prefix}-0000-4000-8000-{number:012d}")


def feature(name: str, geometry: str, coordinates: Any) -> dict[str, Any]:
    return {
        "type": "Feature",
        "properties": {"name": name},
        "geometry": {"type": geometry, "coordinates": coordinates},
    }


def fixture(font: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    def labels(color: str) -> dict[str, Any]:
        return {
            "enabled": True,
            "field": "name",
            "fontRef": font,
            "prefix": "[",
            "suffix": "]",
            "size": 18,
            "color": color,
            "haloColor": "#061526",
            "haloWidth": 1.2,
            "allowOverlap": False,
        }

    layers = []
    for index, name in enumerate(("points", "areas"), 1):
        layers.append(
            {
                "layerId": name,
                "title": f"Exact {name}",
                "order": index - 1,
                "datasetId": str(identifier("80000000", index)),
                "datasetVersionId": str(identifier("82000000", index)),
                "sourceVersion": 1,
                "sourceType": "governed-dataset",
                "geometryType": "Point" if index == 1 else "Polygon",
                "visible": True,
                "opacity": 1 if index == 1 else 0.8,
                "style": {"renderer": "single", "circleColor": "#ef8a75", "circleRadius": 5}
                if index == 1
                else {
                    "fill": "#335577",
                    "stroke": "#bbddff",
                    "strokeWidth": 2,
                    "fillOpacityFactor": 0.75,
                },
                "labels": labels("#75ffdf" if index == 1 else "#ffe070"),
            }
        )
    definition = {
        "schemaVersion": MAP_DEFINITION_SCHEMA_VERSION,
        "mapViews": [{"id": "primary", "center": [0, 0], "zoom": 2, "pitch": 0, "bearing": 0}],
        "basemaps": [
            {
                "basemapId": "blank",
                "title": "Blank canvas",
                "kind": "blank",
                "visible": True,
                "opacity": 1,
                "url": None,
            }
        ],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": layers,
    }
    documents = {
        "points": {
            "type": "FeatureCollection",
            "features": [
                feature("MiXeD Café Ω", "Point", [-28, 20]),
                feature("Blocked overlap", "Point", [-28, 20]),
                feature("Multi β", "MultiPoint", [[8, 22], [36, 22]]),
            ],
        },
        "areas": {
            "type": "FeatureCollection",
            "features": [
                feature(
                    "Café\nΔέλτα",  # noqa: RUF001
                    "Polygon",
                    [
                        [
                            [-38, -4],
                            [-6, -4],
                            [-6, -12],
                            [-26, -12],
                            [-26, -30],
                            [-38, -30],
                            [-38, -4],
                        ]
                    ],
                ),
                feature(
                    "Parts β",
                    "MultiPolygon",
                    [
                        [[[3, -7], [20, -7], [20, -20], [3, -20], [3, -7]]],
                        [[[28, -7], [45, -7], [45, -20], [28, -20], [28, -7]]],
                    ],
                ),
            ],
        },
    }
    return definition, documents


def compile_claim(
    definition: dict[str, Any],
    directory: Path,
    variant: int,
    runtime_reference: RenderRuntimeReference | None = None,
    resolved_styles: dict[str, ResourceStyle] | None = None,
) -> tuple[list[Path], list[RenderLayerClaim], RenderClaim, dict[str, Any]]:
    recipe = compile_saved_map(definition, resolved_styles=resolved_styles)
    identities = {
        layer["layerId"]: SavedMapStyleIdentity(
            identifier("a2000000", variant * 10 + index),
            identifier("a3000000", variant * 10 + index),
            1,
        )
        for index, layer in enumerate(definition["layers"], 1)
    }
    passes = compile_saved_map_passes(
        recipe, style_bindings=identities, runtime_reference=runtime_reference
    )
    layers = []
    sources = []
    resource = identifier("a0000000", 1)
    for item in passes:
        assert item.configuration_json is not None
        assert item.configuration_checksum_sha256 is not None
        path = directory / f"{item.layer_id}.geojson"
        data = path.read_bytes()
        sources.append(path)
        identity = identities[item.layer_id]
        source = ObjectReference(
            identifier("81000000", item.position),
            "local-proof",
            f"{item.layer_id}/preview.geojson",
            "exact-preview-v1",
            "local",
            "application/geo+json",
            len(data),
            sha256(data).hexdigest(),
        )
        layers.append(
            RenderLayerClaim(
                position=item.position,
                resource_id=resource,
                dataset_id=item.dataset_id,
                dataset_version_id=item.dataset_version_id,
                source=source,
                profile_id=identifier("a4000000", variant * 10 + item.position),
                profile_version_id=identifier("a5000000", variant * 10 + item.position),
                style_id=identity.style_id,
                style_version_id=identity.style_version_id,
                configuration=json.loads(item.configuration_json),
                configuration_checksum_sha256=item.configuration_checksum_sha256,
            )
        )
    first = layers[0]
    claim = RenderClaim(
        status="claimed",
        job_id=identifier("a6000000", variant + 1),
        organization_id=identifier("10000000", 1),
        project_id=identifier("50000000", 1),
        resource_id=resource,
        dataset_id=first.dataset_id,
        dataset_version_id=first.dataset_version_id,
        source=first.source,
        profile_id=first.profile_id,
        profile_version_id=first.profile_version_id,
        style_id=first.style_id,
        style_version_id=first.style_version_id,
        configuration=first.configuration,
        configuration_checksum_sha256=first.configuration_checksum_sha256,
        bbox=tuple(saved_view_bbox(definition["mapViews"][0], 640, 480)),
        crs="EPSG:3857",
        width=640,
        height=480,
        format="png",
        request_checksum_sha256="b" * 64,
        attempt_count=1,
        output_prefix="local-proof",
        layers=tuple(layers),
    )
    identity_receipt = {
        "recipeChecksumSha256": recipe.checksum_sha256,
        "orderedLayerIds": [item.layer_id for item in passes],
        "configChecksums": [item.configuration_checksum_sha256 for item in passes],
    }
    return sources, layers, claim, identity_receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-manifest", required=True, type=Path)
    parser.add_argument("--font-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--filters",
        action="store_true",
        help="Compare filtered pixels with equivalent selected source features",
    )
    parser.add_argument(
        "--membership",
        action="store_true",
        help="Compare inclusion and exclusion lists with selected source pixels",
    )
    parser.add_argument(
        "--label-order",
        action="store_true",
        help="Verify raised labels above an opaque covering geometry",
    )
    parser.add_argument(
        "--opacity",
        action="store_true",
        help="Render saved opacity overlap and single-feature images for pixel review",
    )
    parser.add_argument(
        "--patterns",
        action="store_true",
        help="Render a pinned generated pattern and its transparent counterpart",
    )
    arguments = parser.parse_args()
    if arguments.membership:
        arguments.filters = True
    directory = arguments.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        parser.error("--output-dir must be empty; existing files are never overwritten")
    manifest = arguments.font_root / "opengeo-open-sans-v1/1/manifest.json"
    font = {
        "id": "opengeo-open-sans-v1",
        "version": 1,
        "manifestChecksumSha256": sha256(manifest.read_bytes()).hexdigest(),
    }
    definition, documents = fixture(font)
    resolved_styles = None
    if arguments.patterns:
        if any((arguments.opacity, arguments.filters, arguments.membership, arguments.label_order)):
            parser.error("--patterns runs independently of other comparison modes")
        fixtures = (
            Path(__file__).resolve().parents[2] / "api/tests/fixtures/cartographic-patterns.json"
        )
        pattern = next(item for item in json.loads(fixtures.read_text()) if item["id"] == "waves")
        now = datetime.now(UTC)
        style = ResourceStyle(
            identifier("d0000000", 1),
            identifier("a0000000", 1),
            "waves",
            "sld_1_1",
            1,
            "Water & plants",
            "application/xml",
            pattern["definition"],
            sha256(pattern["definition"].encode()).hexdigest(),
            None,
            identifier("80000000", 2),
            now,
            now,
        )
        areas = definition["layers"][1]
        definition["layers"] = [areas]
        definition["schemaVersion"] = "opengeo.map-definition.1.4.0"
        areas["labels"]["enabled"] = False
        areas["styleReference"] = {
            "projectId": str(identifier("50000000", 1)),
            "resourceId": str(style.resource_id),
            "styleId": str(style.style_id),
            "versionNumber": 1,
            "format": style.format,
            "checksumSha256": style.checksum_sha256,
        }
        resolved_styles = {"areas": style}
    if arguments.label_order:
        points, areas = definition["layers"]
        points["order"] = 1
        areas["order"] = 0
        areas["opacity"] = 1
        areas["style"]["fillOpacityFactor"] = 1
        areas["labels"]["enabled"] = False
        documents["points"]["features"] = [feature("Raised label", "Point", [0, 0])]
        documents["areas"]["features"] = [
            feature("Cover", "Polygon", [[[-60, -40], [60, -40], [60, 40], [-60, 40], [-60, -40]]])
        ]
    if arguments.opacity:
        areas = definition["layers"][1]
        definition["layers"] = [areas]
        areas.update(opacity=0.5, filter=["has", "name"])
        areas["labels"]["enabled"] = False
        areas["style"].update(fillOpacityFactor=1, strokeWidth=1, stroke="#00000000")
        polygon = feature(
            "Overlap", "Polygon", [[[-40, -30], [40, -30], [40, 30], [-40, 30], [-40, -30]]]
        )
        documents["areas"]["features"] = [polygon, deepcopy(polygon)]
    for name, document in documents.items():
        (directory / f"{name}.geojson").write_text(json.dumps(document, ensure_ascii=False))
    runtime_identity = json.loads(arguments.runtime_manifest.read_bytes())
    runtime_reference = (
        RenderRuntimeReference(
            sha256(arguments.runtime_manifest.read_bytes()).hexdigest(),
            runtime_identity["architecture"],
        )
        if runtime_identity.get("schema") == "opengeo.maplibre-package.1.0.0"
        else None
    )
    runtime = MapLibreRuntime(
        font_root=arguments.font_root, runtime_manifest=arguments.runtime_manifest
    )
    renderer = DispatchingMapRenderer(gl=MapLibreCompositionRenderer(runtime))
    runs = []
    names = (
        ("unfiltered", "filtered", "selected-source")
        if arguments.filters
        else ("repeat-1", "repeat-2", "repeat-3", "overlap-allowed", "labels-transparent")
    )
    if arguments.membership:
        names = ("unfiltered", "filtered-in", "filtered-not-in", "selected-source")
    if arguments.label_order:
        names = ("with-layer", "above-data", "transparent-labels")
    if arguments.opacity:
        names = ("feature-overlap", "composite-overlap", "composite-single")
    if arguments.patterns:
        names = ("pattern", "transparent-pattern")
    for index, name in enumerate(names):
        selected = deepcopy(definition)
        if name == "transparent-pattern":
            selected["layers"][0]["opacity"] = 0
        if arguments.opacity:
            selected["layers"][0]["opacityMode"] = (
                "feature" if name == "feature-overlap" else "composite"
            )
            document = deepcopy(documents["areas"])
            if name == "composite-single":
                document["features"] = document["features"][:1]
            (directory / "areas.geojson").write_text(json.dumps(document))
        if name == "above-data":
            selected["layers"][0]["labels"]["drawOrder"] = "above-data"
        elif name == "transparent-labels":
            selected["layers"][0]["labels"].update(color="#00000000", haloColor="#00000000")
        if name == "overlap-allowed":
            for layer in selected["layers"]:
                layer["labels"]["allowOverlap"] = True
        elif name == "labels-transparent":
            for layer in selected["layers"]:
                layer["labels"].update(color="#06152600", haloColor="#06152600")
        if arguments.filters:
            for layer in selected["layers"]:
                document = deepcopy(documents[layer["layerId"]])
                chosen = document["features"][0]["properties"]["name"]
                if name == "filtered":
                    layer["filter"] = ["==", ["get", "name"], chosen]
                if name == "filtered-in":
                    layer["filter"] = ["in", ["get", "name"], ["literal", [chosen]]]
                if name == "filtered-not-in":
                    excluded = [
                        item["properties"]["name"]
                        for item in document["features"]
                        if item["properties"]["name"] != chosen
                    ]
                    layer["filter"] = ["!", ["in", ["get", "name"], ["literal", excluded]]]
                if name == "selected-source":
                    document["features"] = [
                        item
                        for item in document["features"]
                        if item["properties"]["name"] == chosen
                    ]
                (directory / f"{layer['layerId']}.geojson").write_text(
                    json.dumps(document, ensure_ascii=False)
                )
        sources, layers, claim, identity = compile_claim(
            selected, directory, index if index > 2 else 0, runtime_reference, resolved_styles
        )
        target = directory / f"{name}.png"
        begin = time.monotonic()
        if len(layers) == 1:
            renderer.render(sources[0], claim, target)
        else:
            renderer.render_composition(sources, layers, claim, target)
        runs.append(
            {
                "name": name,
                "elapsedSeconds": time.monotonic() - begin,
                **identity,
                "engine": runtime.last_receipt,
            }
        )
        (directory / f"{name}.receipt.json").write_text(json.dumps(runs[-1], indent=2) + "\n")
    if arguments.patterns or arguments.opacity:
        assert runs[0]["engine"]["pixelSha256"] != runs[1]["engine"]["pixelSha256"]
        # Duplicate polygon edge coverage can differ; inspect interior pixels separately.
    elif arguments.label_order:
        assert runs[0]["engine"]["pixelSha256"] == runs[2]["engine"]["pixelSha256"]
        assert runs[0]["engine"]["pixelSha256"] != runs[1]["engine"]["pixelSha256"]
    elif arguments.filters:
        assert runs[0]["engine"]["pixelSha256"] != runs[1]["engine"]["pixelSha256"]
        assert len({run["engine"]["pixelSha256"] for run in runs[1:]}) == 1
    else:
        assert len({run["engine"]["pngSha256"] for run in runs[:3]}) == 1
        assert len({run["engine"]["pixelSha256"] for run in runs[:3]}) == 1
        assert runs[3]["engine"]["pixelSha256"] != runs[0]["engine"]["pixelSha256"]
        assert runs[4]["engine"]["pixelSha256"] != runs[0]["engine"]["pixelSha256"]
    receipt = {
        "status": "pass",
        "scope": (
            "Real API compiler and fixed local worker runtime; "
            "no database, Studio or deployment claim"
        ),
        "runtimeManifestSha256": sha256(arguments.runtime_manifest.read_bytes()).hexdigest(),
        "fontRef": font,
        "filteredPixelsEqualSelectedSource": arguments.filters,
        "membershipInclusionAndExclusion": arguments.membership,
        "raisedLabelPixelsVerified": arguments.label_order,
        "savedOpacityImagesRendered": arguments.opacity,
        "savedPatternImagesRendered": arguments.patterns,
        "runs": runs,
    }
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        json.dumps(
            {"status": "pass", "receipt": str(directory / "receipt.json"), "runs": len(runs)}
        )
    )


if __name__ == "__main__":
    main()
