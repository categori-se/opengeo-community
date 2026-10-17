import json
import os
import subprocess
import sys
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from unittest.mock import Mock

import pytest

from opengeo_worker.maplibre_package import verify_package
from opengeo_worker.maplibre_renderer import (
    GL_OCCURRENCE_SCHEMA,
    GL_RENDERER,
    DispatchingMapRenderer,
    MapLibreCompositionRenderer,
    _canonical,
)
from opengeo_worker.maplibre_runtime import FontRegistry, MapLibreRuntime, glyph_ids
from opengeo_worker.models import RenderLayerClaim, ValidationFailure
from opengeo_worker.render_runtime import PINNED_GL_RENDERER, RUNTIME_REFERENCE_SCHEMA
from opengeo_worker.renderer import _RasterCanvas
from test_maplibre_package import build_package, save_manifest
from test_renderer import FIXTURE, GOLDEN, claim

FONT_ROOT = Path(__file__).resolve().parents[3] / "app/src/assets/render-fonts"
FONT_REF = {
    "id": "opengeo-open-sans-v1",
    "version": 1,
    "manifestChecksumSha256": "19aa88722c18ee3005c64d95cded9eda8337d5772939a92e44c53defc930508a",
}


def configuration(position=1, count=1, *, labels=True):
    base = claim()
    parts = [
        {
            "id": f"occurrence-{position}-fill",
            "type": "fill",
            "paint": {"fill-color": "#223344", "fill-opacity": 0.225},
        },
        {
            "id": f"occurrence-{position}-outline",
            "type": "line",
            "paint": {"line-color": "#abcdef", "line-width": 2.0, "line-opacity": 0.5},
        },
    ]
    if labels:
        parts.append(
            {
                "id": f"occurrence-{position}-labels",
                "type": "symbol",
                "layout": {
                    "text-field": ["concat", "[", ["to-string", ["get", "name"]], "]"],
                    "text-font": ["OpenGeo Open Sans v1"],
                    "text-size": 18,
                    "text-offset": [0, 1.1],
                    "text-anchor": "top",
                    "text-allow-overlap": True,
                },
                "paint": {
                    "text-color": "#112233",
                    "text-halo-color": "#ffffff",
                    "text-halo-width": 6,
                },
            }
        )
    style = {"version": 8, "sources": {}, "layers": parts}
    if labels:
        style["metadata"] = {"opengeo:font": FONT_REF}
    style_checksum = sha256(_canonical(style).encode()).hexdigest()
    return {
        "renderer": GL_RENDERER,
        "schema_version": "1.0.0",
        "output_crs": "EPSG:4326",
        "background": "#061526",
        "source_style": {
            "style_id": str(base.style_id),
            "style_version_id": str(base.style_version_id),
            "style_version_number": 1,
            "style_checksum_sha256": style_checksum,
        },
        "saved_map": {
            "schema": GL_OCCURRENCE_SCHEMA,
            "recipe_checksum_sha256": "c" * 64,
            "definition_checksum_sha256": "d" * 64,
            "style_checksum_sha256": style_checksum,
            "layer_id": f"saved-layer-{position}",
            "source_geometry_type": "Polygon",
            "position": position,
            "pass_count": count,
            "dataset_id": str(base.dataset_id),
            "dataset_version_id": str(base.dataset_version_id),
        },
        "map_view": {"center": [0, 0], "zoom": 2, "bearing": 0, "pitch": 0},
        "maplibre_style": style,
        "font_ref": FONT_REF if labels else None,
    }


def request(tmp_path, configs):
    source = tmp_path / "source.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "MiXeD Café\nΔέλτα"},  # noqa: RUF001
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[[-8, -8], [8, -8], [8, 8], [-8, -8]]],
                        },
                    }
                ],
            }
        )
    )
    base = claim(configs[0])
    exact = replace(
        base.source,
        size_bytes=source.stat().st_size,
        checksum_sha256=sha256(source.read_bytes()).hexdigest(),
    )
    layers = tuple(
        RenderLayerClaim(
            position=index,
            resource_id=base.resource_id,
            dataset_id=base.dataset_id,
            dataset_version_id=base.dataset_version_id,
            source=exact,
            profile_id=base.profile_id,
            profile_version_id=base.profile_version_id,
            style_id=base.style_id,
            style_version_id=base.style_version_id,
            configuration=config,
            configuration_checksum_sha256=sha256(
                json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
        )
        for index, config in enumerate(configs, 1)
    )
    extent = 20_037_508.342789244 * 64 / (512 * 4)
    claimed = replace(
        base,
        source=exact,
        crs="EPSG:3857",
        bbox=(-extent, -extent, extent, extent),
        width=64,
        height=64,
        format="png",
        layers=layers,
    )
    return [source] * len(configs), layers, claimed


class CapturingRuntime:
    def __init__(self):
        self.requests = []

    def render(self, request, target):
        self.requests.append(deepcopy(request))
        target.write_bytes(_RasterCanvas(request["width"], request["height"], "#061526").png("{}"))


def execute(tmp_path, configs, *, change_claim=None, runtime=None):
    sources, layers, claimed = request(tmp_path, configs)
    if change_claim:
        claimed = replace(claimed, **change_claim)
    runtime = runtime or CapturingRuntime()
    renderer = MapLibreCompositionRenderer(runtime)
    target = tmp_path / "result.png"
    if len(layers) == 1:
        renderer.render(sources[0], claimed, target)
    else:
        renderer.render_composition(sources, layers, claimed, target)
    return runtime.requests[0]


def pinned_configuration(position=1, count=1):
    return {
        **configuration(position, count),
        "renderer": PINNED_GL_RENDERER,
        "runtime_ref": {
            "schemaVersion": RUNTIME_REFERENCE_SCHEMA,
            "manifestSha256": "a" * 64,
            "architecture": "x86_64",
        },
    }


def test_runtime_pin_is_carried_once_for_the_whole_sealed_composition(tmp_path):
    configs = [pinned_configuration(1, 2), pinned_configuration(2, 2)]
    output = execute(tmp_path, configs)
    assert output["runtimeReference"] == configs[0]["runtime_ref"]
    assert "maplibreVersion" not in output


@pytest.mark.parametrize("mutation", ["missing", "mixed", "downgrade", "unknown"])
def test_inconsistent_runtime_pins_fail_before_renderer_execution(tmp_path, mutation):
    configs = [pinned_configuration(1, 2), pinned_configuration(2, 2)]
    if mutation == "missing":
        del configs[1]["runtime_ref"]
    elif mutation == "mixed":
        configs[1]["runtime_ref"]["manifestSha256"] = "b" * 64
    elif mutation == "downgrade":
        configs[1] = configuration(2, 2)
    else:
        configs[1]["runtime_ref"]["path"] = "/tmp/untrusted"
    runtime = CapturingRuntime()
    with pytest.raises(ValidationFailure):
        execute(tmp_path, configs, runtime=runtime)
    assert not runtime.requests


def test_occurrences_keep_exact_all_layer_order_and_label_semantics_in_one_runtime_call(tmp_path):
    configs = [configuration(1, 2, labels=False), configuration(2, 2)]
    output = execute(tmp_path, configs)
    assert [item["position"] for item in output["occurrences"]] == [1, 2]
    assert [item["style"] for item in output["occurrences"]] == [
        item["maplibre_style"] for item in configs
    ]
    assert [
        [part["type"] for part in item["style"]["layers"]] for item in output["occurrences"]
    ] == [["fill", "line"], ["fill", "line", "symbol"]]
    label = output["occurrences"][1]["style"]["layers"][-1]
    assert label["layout"]["text-allow-overlap"] is True
    assert label["paint"]["text-halo-width"] == 6
    assert output["occurrences"][1]["requiredCodepoints"] == sorted(
        set(map(ord, "[MiXeD CaféΔέλτα]"))  # noqa: RUF001
    )
    assert output["occurrences"][0]["fontRef"] is None


def test_single_occurrence_and_integral_style_floats_keep_distinct_correct_hash_contract(tmp_path):
    config = configuration()
    assert _canonical(2.0) == "2"
    assert '"line-width":2.0' in json.dumps(config, separators=(",", ":"))
    assert execute(tmp_path, [config])["occurrences"][0]["style"] == config["maplibre_style"]


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"bbox": (0, 0, 10, 10)}, "saved_map_gl_view_mismatch"),
        ({"format": "svg"}, "saved_map_gl_request_invalid"),
        ({"crs": "CRS:84"}, "saved_map_gl_request_invalid"),
        ({"transparent": True}, "saved_map_gl_request_invalid"),
        ({"width": 4096}, "saved_map_gl_request_invalid"),
    ],
)
def test_saved_view_or_output_cannot_be_substituted(tmp_path, changes, code):
    with pytest.raises(ValidationFailure, match=code):
        execute(tmp_path, [configuration()], change_claim=changes)


@pytest.mark.parametrize(
    "mutation,code",
    [
        (
            lambda c: c["saved_map"].update(dataset_version_id="other"),
            "saved_map_gl_identity_mismatch",
        ),
        (lambda c: c["saved_map"].update(schema="unknown"), "saved_map_gl_identity_mismatch"),
        (lambda c: c["saved_map"].update(position=True), "saved_map_gl_identity_mismatch"),
        (lambda c: c["saved_map"].update(pass_count=2), "saved_map_gl_sequence_invalid"),
        (
            lambda c: c["source_style"].update(style_version_id="other"),
            "saved_map_gl_identity_mismatch",
        ),
        (
            lambda c: c["maplibre_style"]["metadata"]["opengeo:font"].update(version=2),
            "saved_map_gl_identity_mismatch",
        ),
        (lambda c: c.update(font_ref=None), "saved_map_gl_font_identity_mismatch"),
        (lambda c: c["map_view"].update(pitch=25), "saved_map_gl_view_invalid"),
    ],
)
def test_identity_and_presentation_denials_happen_before_runtime(tmp_path, mutation, code):
    config = deepcopy(configuration())
    mutation(config)
    runtime = CapturingRuntime()
    with pytest.raises(ValidationFailure, match=code):
        execute(tmp_path, [config], runtime=runtime)
    assert not runtime.requests


def test_source_byte_pin_is_verified_before_runtime(tmp_path):
    sources, _layers, claimed = request(tmp_path, [configuration()])
    sources[0].write_text(sources[0].read_text().replace("MiXeD", "Mixed"))
    runtime = CapturingRuntime()
    with pytest.raises(ValidationFailure, match="saved_map_gl_source_checksum_mismatch"):
        MapLibreCompositionRenderer(runtime).render(sources[0], claimed, tmp_path / "result.png")
    assert not runtime.requests


def test_different_recipe_or_camera_in_second_occurrence_is_not_flattened(tmp_path):
    configs = [configuration(1, 2), configuration(2, 2)]
    configs[1]["saved_map"]["recipe_checksum_sha256"] = "e" * 64
    with pytest.raises(ValidationFailure, match="saved_map_gl_sequence_invalid"):
        execute(tmp_path, configs)


def test_dispatch_preserves_real_legacy_golden_and_refuses_mixed_profiles(tmp_path):
    output = tmp_path / "legacy.svg"
    DispatchingMapRenderer().render(FIXTURE, claim(), output)
    assert output.read_bytes() == GOLDEN.read_bytes()
    sources, layers, requested = request(tmp_path, [configuration(1, 2), configuration(2, 2)])
    layers = (layers[0], replace(layers[1], configuration=claim().configuration))
    with pytest.raises(ValidationFailure, match="saved_map_gl_mixed_composition"):
        DispatchingMapRenderer().render_composition(sources, layers, requested, output)


def test_complete_registered_font_validates_actual_pbf_coverage_and_bytes():
    result = FontRegistry(FONT_ROOT).resolve(FONT_REF, list(map(ord, "MiXeD Café Δέλτα")))
    assert result["fontStack"] == "OpenGeo Open Sans v1"
    assert len(result["codepoints"]) == 883
    assert [item["range"] for item in result["ranges"]] == ["0-255", "768-1023"]


@pytest.mark.parametrize("point", [9, 13, 0x4E00, 0x1F600, 0x0627, 0xD800])
def test_uncovered_codepoint_fails_before_any_browser_launch(point):
    with pytest.raises(ValidationFailure, match="saved_map_gl_font_coverage_missing"):
        FontRegistry(FONT_ROOT).resolve(FONT_REF, [point])


def test_unknown_font_and_changed_manifest_are_not_host_font_fallbacks(tmp_path):
    with pytest.raises(ValidationFailure, match="saved_map_gl_font_unavailable"):
        FontRegistry(tmp_path).resolve(FONT_REF, [65])
    with pytest.raises(ValidationFailure, match="saved_map_gl_font_checksum_mismatch"):
        FontRegistry(FONT_ROOT).resolve({**FONT_REF, "manifestChecksumSha256": "0" * 64}, [65])


def test_only_line_feed_is_omitted_from_required_glyphs(tmp_path):
    from opengeo_worker.maplibre_renderer import _required_codepoints

    sources, _layers, _claim = request(tmp_path, [configuration()])
    document = json.loads(sources[0].read_bytes())
    document["features"][0]["properties"]["name"] = "A\nB\rC\tD"
    points = _required_codepoints([configuration()["maplibre_style"]["layers"][-1]], document)
    assert 10 not in points and 9 in points and 13 in points


def test_required_copyright_notice_is_not_silently_omitted(tmp_path):
    origin = FONT_ROOT / FONT_REF["id"] / "1"
    directory = tmp_path / FONT_REF["id"] / "1"
    directory.mkdir(parents=True)
    for name in ("manifest.json", "LICENSE.txt"):
        (directory / name).write_bytes((origin / name).read_bytes())
    with pytest.raises(ValidationFailure, match="saved_map_gl_font_notice_unavailable"):
        FontRegistry(tmp_path).resolve(FONT_REF, [65])


def test_missing_and_tampered_glyph_fail_with_no_implicit_range_substitution(tmp_path):
    origin = FONT_ROOT / FONT_REF["id"] / "1"
    directory = tmp_path / FONT_REF["id"] / "1"
    directory.mkdir(parents=True)
    for name in ("manifest.json", "LICENSE.txt", "NOTICE.txt"):
        (directory / name).write_bytes((origin / name).read_bytes())
    with pytest.raises(ValidationFailure, match="saved_map_gl_glyph_unavailable"):
        FontRegistry(tmp_path).resolve(FONT_REF, [65])
    (directory / "0-255.pbf").write_bytes(b"tampered")
    with pytest.raises(ValidationFailure, match="saved_map_gl_glyph_checksum_mismatch"):
        FontRegistry(tmp_path).resolve(FONT_REF, [65])


def test_malformed_pbf_is_not_accepted_as_empty_font():
    with pytest.raises(ValidationFailure, match="saved_map_gl_glyph_invalid"):
        glyph_ids(b"\xff", "OpenGeo Open Sans v1", "0-255")


def test_absent_runtime_fails_closed_after_font_preflight(tmp_path, monkeypatch):
    start = Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.subprocess.Popen", start)
    runtime = MapLibreRuntime(font_root=FONT_ROOT, runtime_manifest=tmp_path / "absent.json")
    with pytest.raises(ValidationFailure, match="saved_map_gl_runtime_unavailable"):
        execute(tmp_path, [configuration()], runtime=runtime)
    start.assert_not_called()


def test_fixed_script_has_no_fontface_and_requires_network_isolation():
    script = Path(__file__).resolve().parents[1] / "scripts/render-maplibre.mjs"
    source = script.read_text()
    assert "FontFace(" not in source and "@font-face" not in source
    assert "saved_map_gl_network_not_isolated" in source
    assert "saved_map_gl_font_fallback_forbidden" in source
    assert "canvasContextAttributes: {preserveDrawingBuffer: true}" in source


def test_timeout_cleanup_includes_detached_browser_group_but_not_worker(monkeypatch):
    from opengeo_worker.maplibre_runtime import _kill_runtime_tree

    content = {
        "/proc/111/task/111/children": "222 333",
        "/proc/222/task/222/children": "444",
        "/proc/333/task/333/children": "",
        "/proc/444/task/444/children": "",
        "/proc/222/status": "PPid:\t111\n",
        "/proc/333/status": "PPid:\t111\n",
        "/proc/444/status": "PPid:\t222\n",
    }
    monkeypatch.setattr(Path, "read_text", lambda path: content[str(path)])
    monkeypatch.setattr(
        "opengeo_worker.maplibre_runtime.os.getpgid", lambda pid: 111 if pid == 333 else 222
    )
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.os.getpgrp", lambda: 999)
    kill = Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.os.killpg", kill)
    _kill_runtime_tree(111)
    assert {call.args[0] for call in kill.call_args_list} == {111, 222}


@pytest.fixture
def packaged_runtime(tmp_path, monkeypatch):
    monkeypatch.setattr("opengeo_worker.maplibre_package.platform.machine", lambda: "x86_64")
    root, manifest, _checksum = build_package(tmp_path)
    runtime = MapLibreRuntime(font_root=root / "fonts", runtime_manifest=root / "runtime.json")
    return runtime, root, manifest


def runtime_request():
    return {
        "width": 8,
        "height": 8,
        "occurrences": [{"fontRef": FONT_REF, "requiredCodepoints": [65], "style": {"layers": []}}],
        # Neither an executable nor a caller-selected font payload may survive.
        "runtime": {"node": "/untrusted/node"},
        "fonts": [{"fontStack": "untrusted"}],
    }


def fake_runtime_process(monkeypatch, *, mutate=None, packaged=True, wait_error=None):
    started = []
    process = Mock(pid=731111)
    process.wait.side_effect = [wait_error, 0] if wait_error is not None else None
    process.wait.return_value = 0

    def start(command, **options):
        workdir = options["cwd"]
        payload = json.loads((workdir / "request.json").read_bytes())
        path = workdir / "result.png" if packaged else Path(command[-1])
        output = _RasterCanvas(payload["width"], payload["height"], "#061526").png("{}")
        path.write_bytes(output)
        receipt = {
            "status": "pass",
            "localGlyphCalls": 0,
            "fontFaceCount": 0,
            "deniedRequests": 0,
            "maplibreVersion": "5.24.0",
            "pngSha256": sha256(output).hexdigest(),
        }
        if mutate:
            mutate(path, receipt, options, process)
        options["stdout"].write(json.dumps(receipt).encode())
        started.append((command, options, payload))
        return process

    monkeypatch.setattr("opengeo_worker.maplibre_runtime.subprocess.Popen", start)
    return started, process


def test_pinned_package_executes_and_records_the_exact_job_runtime(
    tmp_path, packaged_runtime, monkeypatch
):
    runtime, root, _manifest = packaged_runtime
    reference = {
        "schemaVersion": RUNTIME_REFERENCE_SCHEMA,
        "manifestSha256": sha256((root / "runtime.json").read_bytes()).hexdigest(),
        "architecture": "x86_64",
    }
    started, _process = fake_runtime_process(monkeypatch)
    runtime.render({**runtime_request(), "runtimeReference": reference}, tmp_path / "result.png")
    assert started[0][2]["runtimeReference"] == reference
    assert runtime.last_receipt["runtimeReference"] == reference


@pytest.mark.parametrize(
    "change", ["checksum", "architecture", "self-consistent-replacement", "legacy"]
)
def test_a_new_valid_runtime_cannot_replace_the_package_named_by_an_old_job(
    tmp_path, packaged_runtime, monkeypatch, change
):
    runtime, root, manifest = packaged_runtime
    reference = {
        "schemaVersion": RUNTIME_REFERENCE_SCHEMA,
        "manifestSha256": sha256((root / "runtime.json").read_bytes()).hexdigest(),
        "architecture": "x86_64",
    }
    if change == "checksum":
        reference["manifestSha256"] = "0" * 64
    elif change == "architecture":
        reference["architecture"] = "aarch64"
    elif change == "self-consistent-replacement":
        entry = next(
            item for item in manifest["inventory"] if item["path"] == "rootfs/lib64/libc.so.6"
        )
        path = root / entry["path"]
        data = path.read_bytes() + b"replacement"
        path.chmod(0o644)
        path.write_bytes(data)
        path.chmod(entry["mode"])
        entry.update(sha256=sha256(data).hexdigest(), bytes=len(data))
        save_manifest(root, manifest)
        # This is internally consistent, not merely a damaged installation.
        verify_package(
            root, expected_sha256=sha256((root / "runtime.json").read_bytes()).hexdigest()
        )
    else:
        manifest["schema"] = "opengeo.maplibre-runtime.1.0.0"
        save_manifest(root, manifest)
        reference["manifestSha256"] = sha256((root / "runtime.json").read_bytes()).hexdigest()
    started = Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.subprocess.Popen", started)
    with pytest.raises(ValidationFailure, match="saved_map_gl_runtime_identity_mismatch"):
        runtime.render(
            {**runtime_request(), "runtimeReference": reference}, tmp_path / "result.png"
        )
    started.assert_not_called()
    assert not (tmp_path / "result.png").exists()
    assert runtime.last_receipt is None


def test_package_dispatch_verifies_inventory_and_uses_fixed_namespace_command(
    tmp_path, packaged_runtime, monkeypatch
):
    runtime, root, manifest = packaged_runtime
    target = tmp_path / "result.png"
    started, process = fake_runtime_process(monkeypatch)
    runtime.render(runtime_request(), target)
    command, options, payload = started[0]
    workdir = options["cwd"]
    assert command == [
        "/usr/bin/prlimit",
        "--cpu=30",
        "--fsize=20971520",
        "--nofile=512",
        "--",
        "/usr/bin/unshare",
        "--user",
        "--map-root-user",
        "--net",
        "--mount",
        "--pid",
        "--fork",
        "--kill-child=KILL",
        sys.executable,
        "-I",
        str(root / "launch-maplibre.py"),
        str(root / "rootfs"),
        str(workdir),
    ]
    assert options["start_new_session"] is True and options["close_fds"] is True
    assert options["stdin"] == subprocess.DEVNULL
    assert options["env"] == {
        "PATH": "/usr/bin:/bin",
        "TMPDIR": str(workdir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    process.wait.assert_called_once_with(timeout=30)
    inventory = {item["path"]: item for item in manifest["inventory"]}
    for name, relative in manifest["entrypoints"].items():
        assert payload["runtime"][name] == f"/{relative}"
        assert (
            payload["runtime"][f"{name}ChecksumSha256"] == inventory[f"rootfs/{relative}"]["sha256"]
        )
    assert str(root) not in json.dumps(payload)
    assert payload["fonts"][0]["fontRef"] == FONT_REF
    assert payload["fonts"][0]["ranges"][0]["range"] == "0-255"
    assert runtime.last_receipt["pngSha256"] == sha256(target.read_bytes()).hexdigest()
    assert not workdir.exists()


@pytest.mark.parametrize("mutation", ["native-byte", "extra-file", "legacy-kind", "unknown-schema"])
def test_invalid_package_never_launches_or_falls_back(
    tmp_path, packaged_runtime, monkeypatch, mutation
):
    runtime, root, manifest = packaged_runtime
    if mutation == "native-byte":
        path = root / "rootfs/lib64/libc.so.6"
        path.chmod(0o644)
        path.write_bytes(b"changed native dependency")
        path.chmod(0o444)
    elif mutation == "extra-file":
        (root / "unlisted").write_text("not inventoried")
    else:
        if mutation == "legacy-kind":
            manifest["sandbox"]["kind"] = "user-mount-pid-net-chroot.v1"
        else:
            manifest["schema"] = "other"
        save_manifest(root, manifest)
    start, legacy = Mock(), Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.subprocess.Popen", start)
    monkeypatch.setattr(runtime, "_runtime", legacy)
    with pytest.raises(ValidationFailure):
        runtime.render(runtime_request(), tmp_path / "result.png")
    start.assert_not_called()
    legacy.assert_not_called()
    assert runtime.last_receipt is None


@pytest.mark.parametrize("external", ["root", "reference"])
def test_package_fonts_cannot_be_resolved_from_outside_inventory(
    tmp_path, packaged_runtime, monkeypatch, external
):
    runtime, root, _manifest = packaged_runtime
    requested = runtime_request()
    if external == "root":
        runtime = MapLibreRuntime(font_root=FONT_ROOT, runtime_manifest=root / "runtime.json")
    else:
        requested["occurrences"][0]["fontRef"] = {**FONT_REF, "version": 2}
    start = Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.subprocess.Popen", start)
    with pytest.raises(ValidationFailure, match="saved_map_gl_font_identity_mismatch"):
        runtime.render(requested, tmp_path / "result.png")
    start.assert_not_called()


@pytest.mark.parametrize(
    "failure,code",
    [
        ("boundary", "saved_map_gl_runtime_failed"),
        ("stdout", "saved_map_gl_runtime_output_limit"),
        ("stderr", "saved_map_gl_runtime_output_limit"),
        ("receipt", "saved_map_gl_runtime_failed"),
        ("hash", "saved_map_gl_output_invalid"),
        ("png", "saved_map_gl_output_invalid"),
        ("dimensions", "saved_map_gl_output_invalid"),
        ("symlink", "saved_map_gl_output_invalid"),
        ("fifo", "saved_map_gl_output_invalid"),
        ("absent", "saved_map_gl_output_invalid"),
    ],
)
def test_failed_package_result_never_installs_output(
    tmp_path, packaged_runtime, monkeypatch, failure, code
):
    runtime, _root, _manifest = packaged_runtime
    target = tmp_path / "result.png"

    def mutate(path, receipt, options, process):
        assert not target.exists()
        if failure == "boundary":
            process.wait.return_value = 1
        elif failure in {"stdout", "stderr"}:
            options[failure].write(b"x" * 65_537)
        elif failure == "receipt":
            receipt["fontFaceCount"] = 1
        elif failure == "hash":
            receipt["pngSha256"] = "0" * 64
        else:
            if failure == "dimensions":
                path.write_bytes(_RasterCanvas(16, 8, "#061526").png("{}"))
            elif failure == "png":
                path.write_bytes(b"not PNG")
            else:
                content = path.read_bytes()
                path.unlink()
                if failure == "symlink":
                    origin = tmp_path / "other.png"
                    origin.write_bytes(content)
                    path.symlink_to(origin)
                elif failure == "fifo":
                    os.mkfifo(path)
            if failure in {"dimensions", "png"}:
                receipt["pngSha256"] = sha256(path.read_bytes()).hexdigest()

    started, _process = fake_runtime_process(monkeypatch, mutate=mutate)
    with pytest.raises(ValidationFailure, match=code):
        runtime.render(runtime_request(), target)
    assert not target.exists() and runtime.last_receipt is None
    assert not started[0][1]["cwd"].exists()


def test_package_output_does_not_overwrite_existing_target(tmp_path, packaged_runtime, monkeypatch):
    runtime, _root, _manifest = packaged_runtime
    target = tmp_path / "result.png"
    target.write_bytes(b"user's previous output")
    fake_runtime_process(monkeypatch)
    with pytest.raises(ValidationFailure, match="saved_map_gl_runtime_unavailable"):
        runtime.render(runtime_request(), target)
    assert target.read_bytes() == b"user's previous output"
    assert runtime.last_receipt is None


@pytest.mark.parametrize("cancelled", [False, True])
def test_package_timeout_and_cancellation_clean_owned_process_tree(
    tmp_path, packaged_runtime, monkeypatch, cancelled
):
    runtime, _root, _manifest = packaged_runtime
    failure = KeyboardInterrupt() if cancelled else subprocess.TimeoutExpired("sandbox", 30)
    started, process = fake_runtime_process(monkeypatch, wait_error=failure)
    cleanup = Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime._kill_runtime_tree", cleanup)
    with pytest.raises(KeyboardInterrupt if cancelled else ValidationFailure):
        runtime.render(runtime_request(), tmp_path / "result.png")
    cleanup.assert_called_once_with(process.pid)
    assert process.wait.call_count == 2
    assert not (tmp_path / "result.png").exists()
    assert not started[0][1]["cwd"].exists()


def test_legacy_seven_file_runtime_keeps_explicit_schema_and_existing_command(
    tmp_path, monkeypatch
):
    files = {}
    for name in ("node", "browser", "script", "bundle", "playwrightPackage", "unshare", "prlimit"):
        path = tmp_path / name
        path.write_bytes(name.encode())
        files[name] = {"path": str(path), "checksumSha256": sha256(name.encode()).hexdigest()}
    manifest = tmp_path / "legacy.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": "opengeo.maplibre-runtime.1.0.0",
                "maplibreVersion": "5.24.0",
                "playwrightVersion": "1.61.1",
                "browserVersion": "151.0.7922.71",
                "files": files,
            }
        )
    )
    runtime = MapLibreRuntime(font_root=FONT_ROOT, runtime_manifest=manifest)
    started, _process = fake_runtime_process(monkeypatch, packaged=False)
    target = tmp_path / "result.png"
    runtime.render(runtime_request(), target)
    command, options, payload = started[0]
    assert command == [
        str(tmp_path / "prlimit"),
        "--cpu=30",
        "--fsize=20971520",
        "--nofile=512",
        "--",
        str(tmp_path / "unshare"),
        "--user",
        "--map-root-user",
        "--net",
        str(tmp_path / "node"),
        "--max-old-space-size=256",
        str(tmp_path / "script"),
        str(options["cwd"] / "request.json"),
        str(target),
    ]
    assert payload["runtime"]["node"] == str(tmp_path / "node")
    assert runtime.last_receipt["pngSha256"] == sha256(target.read_bytes()).hexdigest()


def test_supported_filters_reach_runtime_unchanged_and_invalid_filters_fail(tmp_path):
    config = configuration(labels=False)
    predicate = ["all", ["has", "name"], ["!=", ["get", "name"], "hidden"]]
    config["maplibre_style"]["layers"][0]["filter"] = predicate
    digest = sha256(_canonical(config["maplibre_style"]).encode()).hexdigest()
    config["source_style"]["style_checksum_sha256"] = digest
    config["saved_map"]["style_checksum_sha256"] = digest
    request_body = execute(tmp_path, [config])
    assert predicate in [
        part.get("filter") for part in request_body["occurrences"][0]["style"]["layers"]
    ]
    config["maplibre_style"]["layers"][0]["filter"] = ["within", {"type": "Polygon"}]
    digest = sha256(_canonical(config["maplibre_style"]).encode()).hexdigest()
    config["source_style"]["style_checksum_sha256"] = digest
    config["saved_map"]["style_checksum_sha256"] = digest
    with pytest.raises(ValidationFailure, match="saved_map_gl_filter_unsupported"):
        execute(tmp_path, [config])


def test_api_and_worker_filter_validation_contracts_stay_identical():
    root = Path(__file__).resolve().parents[3]
    assert (root / "services/api/src/opengeo_api/map_filters.py").read_bytes() == (
        root / "services/worker/src/opengeo_worker/map_filters.py"
    ).read_bytes()


def test_label_order_requires_reviewed_fixed_script_before_launch(tmp_path, monkeypatch):
    from opengeo_worker.render_runtime import LABEL_ORDER_SCRIPT_HASHES, require_render_capabilities

    fixed = Path(__file__).resolve().parents[1] / "scripts/render-maplibre.mjs"
    digest = sha256(fixed.read_bytes()).hexdigest()
    assert digest in LABEL_ORDER_SCRIPT_HASHES
    request = {
        "occurrences": [
            {
                "fontRef": None,
                "style": {"layers": [{"metadata": {"opengeo:drawOrder": "above-data"}}]},
            }
        ]
    }
    require_render_capabilities(request, {"scriptChecksumSha256": digest})
    runtime = MapLibreRuntime(font_root=FONT_ROOT)
    monkeypatch.setattr(runtime, "_package", lambda *args: None)
    monkeypatch.setattr(runtime, "_runtime", lambda: {"scriptChecksumSha256": "0" * 64})
    launch = Mock()
    monkeypatch.setattr("opengeo_worker.maplibre_runtime.subprocess.Popen", launch)
    with pytest.raises(ValidationFailure, match="saved_map_gl_label_order_runtime_unsupported"):
        runtime.render(request, tmp_path / "output.png")
    launch.assert_not_called()
    request["occurrences"][0]["style"]["layers"][0].pop("metadata")
    require_render_capabilities(request, {"scriptChecksumSha256": "0" * 64})


@pytest.mark.parametrize("receipt_version", ["6.0.0", "5.24.0"])
def test_v6_package_binds_payload_and_checks_child_engine(
    tmp_path, packaged_runtime, monkeypatch, receipt_version
):
    runtime, root, manifest = packaged_runtime
    manifest["maplibreVersion"] = "6.0.0"
    save_manifest(root, manifest)
    reference = {
        "schemaVersion": RUNTIME_REFERENCE_SCHEMA,
        "manifestSha256": sha256((root / "runtime.json").read_bytes()).hexdigest(),
        "architecture": "x86_64",
    }

    def mutate(_path, receipt, _options, _process):
        receipt["maplibreVersion"] = receipt_version

    started, _ = fake_runtime_process(monkeypatch, mutate=mutate)
    request = {**runtime_request(), "runtimeReference": reference}
    if receipt_version == "6.0.0":
        runtime.render(request, tmp_path / "result.png")
    else:
        with pytest.raises(ValidationFailure, match="saved_map_gl_runtime_failed"):
            runtime.render(request, tmp_path / "result.png")
    assert started[0][2]["maplibreVersion"] == "6.0.0"


def test_legacy_engine_is_not_reinterpreted_by_v6_runtime():
    from opengeo_worker.render_runtime import bound_engine_version

    with pytest.raises(ValidationFailure, match="engine_identity_mismatch"):
        bound_engine_version({}, {"maplibreVersion": "6.0.0"})
    with pytest.raises(ValidationFailure, match="engine_identity_mismatch"):
        bound_engine_version(
            {"runtimeReference": {}, "maplibreVersion": "5.24.0"}, {"maplibreVersion": "6.0.0"}
        )
    assert bound_engine_version({}, {"maplibreVersion": "5.24.0"}) == "5.24.0"


def test_composite_opacity_requires_v6_before_render_launch():
    from opengeo_worker.render_runtime import require_render_capabilities

    request = {"occurrences": [{"style": {"layers": [{"paint": {"fill-layer-opacity": 0.5}}]}}]}
    with pytest.raises(ValidationFailure, match="composite_opacity_runtime_unsupported"):
        require_render_capabilities(request, {"maplibreVersion": "5.24.0"})
    require_render_capabilities(request, {"maplibreVersion": "6.0.0"})


def test_bounded_pattern_assets_and_paints_are_validated():
    from opengeo_worker.maplibre_renderer import _validate_style

    fixtures = json.loads(
        (Path(__file__).parents[2] / "api/tests/fixtures/cartographic-patterns.json").read_text()
    )
    for fixture in fixtures:
        identifier = "pattern-" + "a" * 64
        style = {
            "version": 8,
            "sources": {},
            "metadata": {"opengeo:patterns": {identifier: {"svg": fixture["svg"], "size": 24}}},
            "layers": [
                {
                    "id": "water",
                    "type": "fill",
                    "paint": {"fill-pattern": identifier, "fill-opacity": 0.8},
                }
            ],
        }
        assert _validate_style(style, None) == []
        for bad in [
            fixture["svg"].replace("<path", "<script"),
            fixture["svg"].replace('stroke-linecap="round"', 'href="https://example.org"'),
            fixture["svg"].replace('stroke-width="2"', 'stroke-width="99"'),
        ]:
            changed = deepcopy(style)
            changed["metadata"]["opengeo:patterns"][identifier]["svg"] = bad
            with pytest.raises(ValidationFailure):
                _validate_style(changed, None)
        style["layers"][0]["paint"]["fill-pattern"] = "missing"
        with pytest.raises(ValidationFailure):
            _validate_style(style, None)


def test_pattern_rendering_requires_reviewed_worker_script():
    from opengeo_worker.render_runtime import require_render_capabilities

    request = {
        "occurrences": [{"style": {"metadata": {"opengeo:patterns": {"tile": {}}}, "layers": []}}]
    }
    with pytest.raises(ValidationFailure, match="pattern_runtime_unsupported"):
        require_render_capabilities(request, {"scriptChecksumSha256": "a" * 64})
    script = Path(__file__).parents[1] / "scripts/render-maplibre.mjs"
    require_render_capabilities(
        request, {"scriptChecksumSha256": sha256(script.read_bytes()).hexdigest()}
    )
