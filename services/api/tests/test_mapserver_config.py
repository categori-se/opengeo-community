import json
from copy import deepcopy
from hashlib import sha256
from pathlib import Path

import pytest

from opengeo_api.maplibre_render import compile_maplibre_render_configuration
from opengeo_api.mapserver_config import (
    MAPSERVER_COMMIT,
    MAPSERVER_VERSION,
    REQUEST_LIMITS,
    MapServerConfigurationInvalid,
    MapServerConfigurationUnsafe,
    convert_mapserver_configuration,
    export_mapserver_configuration,
)

MAPFILE = (
    Path(__file__).parents[3]
    / "parity"
    / "fixtures"
    / "mapserver"
    / "deterministic-roads-mapserver.map"
).read_text()


def test_converts_exact_mapserver_mapfile_into_activatable_governed_style() -> None:
    converted = convert_mapserver_configuration(MAPFILE)

    assert converted.report["source_version"] == MAPSERVER_VERSION
    assert converted.report["source_commit"] == MAPSERVER_COMMIT
    assert converted.report["source_sha256"] == sha256(MAPFILE.encode()).hexdigest()
    assert converted.report["selected_layer"] == "roads"
    assert converted.report["unsupported_semantics_execute"] is False
    assert converted.report["removed_data_bindings"] == [
        "CONNECTION",
        "CONNECTIONTYPE",
        "DATA",
    ]
    assert converted.geometry_layer_id == "mapserver-roads"
    assert converted.label_layer_id == "mapserver-roads-labels"
    assert converted.request_limits == REQUEST_LIMITS
    assert "CONNECTION" not in converted.canonical_mapfile
    assert "DATA" not in converted.canonical_mapfile
    assert "CLASSITEM status" not in converted.canonical_mapfile
    assert 'CLASSITEM "status"' in converted.canonical_mapfile

    configuration, checksum = compile_maplibre_render_configuration(
        converted.style_definition,
        style_id="10000000-0000-4000-8000-000000000001",
        style_version_id="10000000-0000-4000-8000-000000000002",
        style_version_number=1,
        style_checksum_sha256=sha256(converted.style_definition.encode()).hexdigest(),
        geometry_layer_id=converted.geometry_layer_id,
        label_layer_id=converted.label_layer_id,
        minimum_scale_denominator=converted.minimum_scale_denominator,
        maximum_scale_denominator=converted.maximum_scale_denominator,
        include_legend=converted.include_legend,
    )
    assert configuration["schema"] == "opengeo.render.v1"
    assert configuration["geometry"]["classification"] == {
        "field": "status",
        "rules": [
            {"value": "open", "color": "#16815f", "label": "open"},
            {"value": "closed", "color": "#b42318", "label": "closed"},
        ],
        "fallback_color": "#16815f",
    }
    assert configuration["label"]["field"] == "name"
    assert len(checksum) == 64


def test_exports_only_the_detached_checksum_verified_configuration() -> None:
    converted = convert_mapserver_configuration(MAPFILE, mapscript="mapObj.draw()")
    exported, report = export_mapserver_configuration(converted.style_definition)

    assert exported == converted.canonical_mapfile
    assert report["status"] == "exported_detached_configuration"
    assert report["canonical_mapfile_sha256"] == sha256(exported.encode()).hexdigest()
    assert report["mapscript"] == {
        "supplied": True,
        "executed": False,
        "stored": False,
        "bytes": 13,
        "sha256": sha256(b"mapObj.draw()").hexdigest(),
        "outcome": "reported_not_executed",
    }
    assert "mapObj.draw" not in converted.style_definition

    reconverted = convert_mapserver_configuration(exported)
    assert reconverted.geometry_layer_id == converted.geometry_layer_id
    assert reconverted.label_layer_id == converted.label_layer_id


def test_export_rejects_forged_adapter_metadata_or_changed_style() -> None:
    converted = convert_mapserver_configuration(MAPFILE)
    document = json.loads(converted.style_definition)
    adapter = document["metadata"]["opengeo"]["mapserver_adapter"]

    data_bearing = deepcopy(document)
    unsafe_mapfile = converted.canonical_mapfile.replace(
        '    NAME "roads"\n',
        '    NAME "roads"\n    DATA "private/roads.shp"\n',
    )
    unsafe_adapter = data_bearing["metadata"]["opengeo"]["mapserver_adapter"]
    unsafe_adapter["canonical_mapfile"] = unsafe_mapfile
    unsafe_adapter["canonical_mapfile_sha256"] = sha256(unsafe_mapfile.encode()).hexdigest()
    with pytest.raises(MapServerConfigurationInvalid, match="mapserver_export_not_detached"):
        export_mapserver_configuration(json.dumps(data_bearing))

    changed_style = deepcopy(document)
    changed_style["layers"][0]["paint"]["line-color"] = "#000000"
    with pytest.raises(MapServerConfigurationInvalid, match="mapserver_export_style_changed"):
        export_mapserver_configuration(json.dumps(changed_style))

    untrusted_report = deepcopy(document)
    untrusted_report["metadata"]["opengeo"]["mapserver_adapter"]["losses"] = [
        {"code": "unsupported_directive", "directive": "GAP", "path": "secret=value", "line": 1}
    ]
    with pytest.raises(MapServerConfigurationInvalid, match="mapserver_adapter_losses_invalid"):
        export_mapserver_configuration(json.dumps(untrusted_report))

    wrong_identity = deepcopy(document)
    wrong_identity["metadata"]["opengeo"]["mapserver_adapter"]["source_commit"] = "0" * 40
    with pytest.raises(MapServerConfigurationInvalid, match="mapserver_adapter_metadata_invalid"):
        export_mapserver_configuration(json.dumps(wrong_identity))

    assert adapter["source_commit"] == MAPSERVER_COMMIT


@pytest.mark.parametrize("directive", ["INCLUDE", "CONFIG", "PLUGIN", "TEMPLATE"])
def test_rejects_executable_or_file_loading_directives(directive: str) -> None:
    with pytest.raises(MapServerConfigurationUnsafe) as raised:
        convert_mapserver_configuration(
            f'MAP\n  NAME "unsafe"\n  {directive} "unreviewed"\n'
            '  LAYER\n    NAME "roads"\n    TYPE LINE\n'
            "    CLASS\n      STYLE\n        COLOR 1 2 3\n      END\n    END\n  END\nEND\n"
        )
    assert raised.value.directive == directive


def test_reports_unsupported_semantics_without_preserving_values() -> None:
    converted = convert_mapserver_configuration(
        'MAP\n  NAME "bounded"\n  LAYER\n    NAME "roads"\n    TYPE LINE\n'
        '    CONNECTION "postgresql://user:secret@example.test/db"\n'
        '    CLASS\n      NAME "Road"\n      STYLE\n        COLOR 1 2 3\n'
        "        GAP 3\n      END\n    END\n  END\nEND\n"
    )

    assert {loss["code"] for loss in converted.report["losses"]} == {
        "governed_binding_required",
        "unsupported_directive",
    }
    assert "secret" not in converted.style_definition
    assert "secret" not in converted.canonical_mapfile


def test_rejects_non_utf8_scalar_input_as_a_bounded_validation_error() -> None:
    with pytest.raises(MapServerConfigurationInvalid, match="mapserver_mapfile_utf8_invalid"):
        convert_mapserver_configuration('MAP\n  NAME "\ud800"\nEND\n')
    with pytest.raises(MapServerConfigurationInvalid, match="mapscript_utf8_invalid"):
        convert_mapserver_configuration(MAPFILE, mapscript="\ud800")


def test_requires_explicit_selection_for_a_multi_layer_mapfile() -> None:
    layer = (
        '  LAYER\n    NAME "{name}"\n    TYPE POINT\n'
        "    CLASS\n      STYLE\n        COLOR 1 2 3\n      END\n    END\n  END\n"
    )
    document = "MAP\n" + layer.format(name="one") + layer.format(name="two") + "END\n"
    with pytest.raises(MapServerConfigurationInvalid, match="mapserver_layer_selection_required"):
        convert_mapserver_configuration(document)

    selected = convert_mapserver_configuration(document, layer_name="two")
    assert selected.report["selected_layer"] == "two"
    assert 'NAME "one"' not in selected.canonical_mapfile
    assert 'NAME "two"' in selected.canonical_mapfile
