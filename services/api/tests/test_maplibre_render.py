import json

import pytest

from opengeo_api.maplibre_render import (
    MapLibreRenderUnsupported,
    compile_maplibre_render_configuration,
)


def compile_style(definition: dict, **overrides: object) -> tuple[dict, str]:
    arguments = {
        "style_id": "10000000-0000-4000-8000-000000000001",
        "style_version_id": "20000000-0000-4000-8000-000000000002",
        "style_version_number": 3,
        "style_checksum_sha256": "a" * 64,
        "geometry_layer_id": "roads",
        "label_layer_id": "road-labels",
        "minimum_scale_denominator": 1_000.0,
        "maximum_scale_denominator": 2_000_000.0,
        "include_legend": True,
        **overrides,
    }
    return compile_maplibre_render_configuration(
        json.dumps(definition, separators=(",", ":")),
        **arguments,  # type: ignore[arg-type]
    )


def style() -> dict:
    return {
        "version": 8,
        "sources": {},
        "layers": [
            {
                "id": "roads",
                "type": "line",
                "paint": {
                    "line-color": [
                        "match",
                        ["get", "status"],
                        "open",
                        "#16815f",
                        "closed",
                        "#b42318",
                        "#667085",
                    ],
                    "line-width": 3,
                    "line-opacity": 0.85,
                },
            },
            {
                "id": "road-labels",
                "type": "symbol",
                "layout": {"text-field": ["get", "name"], "text-size": 11},
                "paint": {
                    "text-color": "#172824",
                    "text-halo-color": "#ffffff",
                    "text-halo-width": 1,
                },
            },
            {"id": "ignored", "type": "background"},
        ],
    }


def test_compiles_a_deterministic_bounded_maplibre_subset_with_explicit_losses() -> None:
    first, first_checksum = compile_style(style())
    second, second_checksum = compile_style(style())

    assert first == second
    assert first_checksum == second_checksum
    assert first["schema"] == "opengeo.render.v1"
    assert first["renderer"] == "opengeo.deterministic-svg.v2"
    assert first["geometry"]["type"] == "line"
    assert first["geometry"]["classification"]["field"] == "status"
    assert first["label"]["field"] == "name"
    assert first["label"]["font"] == "opengeo-uppercase-5x7-v1"
    assert first["conversion"] == {
        "status": "bounded_subset",
        "ignored_layer_ids": ["ignored"],
        "unsupported_semantics_are_rejected": True,
    }


def test_compiles_a_versioned_bounded_kernel_density_heatmap() -> None:
    document = style()
    document["layers"][0] = {
        "id": "roads",
        "type": "heatmap",
        "paint": {
            "heatmap-color": [
                "interpolate",
                ["linear"],
                ["heatmap-density"],
                0,
                "#2c7bb6",
                0.5,
                "#ffffbf",
                1,
                "#d7191c",
            ],
            "heatmap-radius": 28,
            "heatmap-intensity": 1.5,
            "heatmap-opacity": 0.7,
        },
    }

    configuration, _ = compile_style(document, label_layer_id=None)

    assert configuration["renderer"] == "opengeo.deterministic-svg.v2"
    assert configuration["geometry"] == {
        "type": "heatmap",
        "color": "#d7191c",
        "colors": ["#2c7bb6", "#ffffbf", "#d7191c"],
        "kernel": "mapserver-gaussian",
        "normalization": "positive-minimum-over-visible-peak",
        "quantization_levels": 31,
        "opacity": 0.7,
        "radius": 28.0,
        "intensity": 1.5,
    }


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (lambda value: value.update(version=7), "maplibre_style_version_unsupported"),
        (
            lambda value: value["layers"][0]["paint"].update(
                {"line-color": ["interpolate", ["linear"], ["zoom"], 0, "#000000"]}
            ),
            "maplibre_color_expression_unsupported",
        ),
        (
            lambda value: value["layers"][1]["layout"].update({"text-field": "{name}"}),
            "maplibre_label_field_unsupported",
        ),
        (
            lambda value: value["layers"][0].update({"type": "fill-extrusion"}),
            "maplibre_geometry_type_unsupported",
        ),
        (
            lambda value: value["layers"][0].update(
                {
                    "type": "heatmap",
                    "paint": {
                        "heatmap-color": [
                            "interpolate",
                            ["exponential", 2],
                            ["heatmap-density"],
                            0,
                            "#000000",
                            1,
                            "#ffffff",
                        ]
                    },
                }
            ),
            "maplibre_heatmap_color_unsupported",
        ),
    ],
)
def test_rejects_unimplemented_style_semantics_instead_of_rendering_them_silently(
    mutation, code: str
) -> None:
    document = style()
    mutation(document)
    with pytest.raises(MapLibreRenderUnsupported, match=code):
        compile_style(document)
