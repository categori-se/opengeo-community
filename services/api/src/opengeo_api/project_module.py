"""ES module delivery of an already compiled portable Artifact; no builds or I/O.

The retained HTML is data in the importing realm and runs only in an opaque-origin
iframe. This representation needs no Studio client, external imports or refetch.
Downloaded copies remain copies: revocation governs subsequent endpoint reads.
"""

import json
from typing import Any, cast


def project_module(
    html: bytes, metadata: dict[str, Any], *, public_origins: list[str] | None = None
) -> bytes:
    def literal(value: Any) -> str:
        return (
            json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("&", "\\u0026")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        )

    # Metadata is an allowlisted public projection, never storage coordinates,
    # browser manifest contents, auth context, source URLs or credentials.
    origins = " ".join(public_origins or [])
    policy = (
        (
            "default-src 'none'; script-src 'unsafe-inline' blob:; "
            f"style-src 'unsafe-inline'; img-src data: blob: {origins}; font-src data: blob:; "
            f"worker-src blob:; connect-src blob: {origins}; frame-src 'none'; "
            "base-uri 'none'; form-action 'none'"
        )
        if origins
        else (
            "default-src 'none'; script-src 'unsafe-inline' blob:; "
            "style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; "
            "worker-src blob:; connect-src blob:; frame-src 'none'; "
            "base-uri 'none'; form-action 'none'"
        )
    )
    return (
        "// OpenGeo portable Project module v1. No external imports.\n"
        f"export const artifact = Object.freeze({literal(metadata)});\n"
        f"export const html = {literal(html.decode('utf-8', errors='strict'))};\n"
        f"const policy = {literal(policy)};\n"
        + r"""
export function createView({height = 600, width = "100%", invalidation, signal,
  document: ownerDocument = globalThis.document} = {}) {
  if (!ownerDocument?.createElement) {
    throw new Error("A browser document is required to show this Project.");
  }
  const root = ownerDocument.createElement("div");
  const frame = ownerDocument.createElement("iframe");
  frame.title = artifact.title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.width = typeof width === "number" ? `${width}px` : String(width);
  frame.style.height = typeof height === "number" ? `${height}px` : String(height);
  frame.style.border = "0";
  // A srcdoc loses the delivery endpoint's CSP. Restore it before any retained
  // content, in addition to the iframe sandbox; the import itself executes none.
  frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="'
    + policy + '">' + html;
  const credit = ownerDocument.createElement("small");
  credit.textContent = `${artifact.attribution} · ${artifact.license}`;
  root.append(frame, credit);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    frame.srcdoc = "";
    root.remove();
  };
  Object.defineProperty(root, "dispose", {value: dispose});
  if (signal?.aborted) dispose();
  else signal?.addEventListener("abort", dispose, {once: true});
  if (invalidation) Promise.resolve(invalidation).then(dispose, dispose);
  return root;
}

// Compiled classic Observable notebook interface. Framework and Notebook Kit
// use the named createView export with their display/invalidation builtins.
export default function define(runtime, observer = () => undefined) {
  const main = runtime.module();
  main.variable(observer("artifact")).define("artifact", () => artifact);
  main.variable(observer("project")).define("project", ["invalidation"],
    invalidation => createView({invalidation}));
  return main;
}
"""
    ).encode("utf-8")


class NativePayloadUnsupported(ValueError):
    """The retained output remains available through its isolated iframe."""


_POINT_SYMBOL_IMAGES = {
    f"opengeo-point-{symbol}-v1"
    for symbol in ("circle", "hospital", "clinic", "school", "star", "flag")
}


def _point_symbol_images(layer: dict[str, Any]) -> set[str]:
    """Admit only the compiler's bounded, locally packaged Point icon profile."""

    def require(value: Any) -> None:
        if not value:
            raise NativePayloadUnsupported("unsupported_point_symbol_assets")

    def category(value: Any) -> bool:
        return (
            isinstance(value, str)
            and 1 <= len(value) <= 128
            and value not in {"__proto__", "constructor", "prototype"}
            and all(ord(character) >= 32 and ord(character) != 127 for character in value)
        )

    layout: Any = layer.get("layout")
    paint: Any = layer.get("paint")
    require(
        isinstance(layout, dict)
        and set(layout)
        <= {"icon-image", "icon-size", "icon-allow-overlap", "icon-ignore-placement", "visibility"}
    )
    require(layout.get("visibility", "visible") in {"visible", "none"})
    require(
        layout.get("icon-allow-overlap") is True and layout.get("icon-ignore-placement") is True
    )
    require(type(layout.get("icon-size")) in {int, float} and 0.125 <= layout["icon-size"] <= 1.5)
    require(isinstance(paint, dict) and set(paint) == {"icon-opacity"})
    require(type(paint["icon-opacity"]) in {int, float} and 0 <= paint["icon-opacity"] <= 1)
    image = layout.get("icon-image")
    if isinstance(image, str):
        require(image in _POINT_SYMBOL_IMAGES)
        return {image}
    require(isinstance(image, list) and 5 <= len(image) <= 99 and len(image) % 2 == 1)
    require(image[0] == "match" and isinstance(image[1], list) and len(image[1]) == 2)
    require(
        image[1][0] == "to-string"
        and isinstance(image[1][1], list)
        and len(image[1][1]) == 2
        and image[1][1][0] == "get"
        and category(image[1][1][1])
    )
    categories, images = image[2:-1:2], [*image[3:-1:2], image[-1]]
    require(
        all(category(value) for value in categories) and len(set(categories)) == len(categories)
    )
    require(all(isinstance(value, str) and value in _POINT_SYMBOL_IMAGES for value in images))
    return set(images)


def native_payload(html: bytes, manifest: dict[str, Any]) -> dict[str, Any]:
    """Read only the compiler's strict JSON; never interpret retained JavaScript."""
    from hashlib import sha256

    from opengeo_api.json_canonical import canonical_json_bytes
    from opengeo_api.portable_artifacts import validate_portable_bytes

    def reject(reason: str) -> None:
        raise NativePayloadUnsupported(reason)

    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value or key in {"__proto__", "constructor", "prototype"}:
                reject("unsupported_json_key")
            value[key] = item
        return value

    def finite(_: str) -> Any:
        reject("nonfinite_json")

    def require(value: Any, reason: str = "unsupported_portable_payload") -> None:
        if not value:
            reject(reason)

    try:
        validate_portable_bytes(html, canonical_json_bytes(manifest))
        text = html.decode("utf-8", errors="strict")
        marker = "<script>const publication="
        require(text.count(marker) == 1, "known_portable_payload_required")
        tail = text.split(marker, 1)[1]
        payload, end = json.JSONDecoder(object_pairs_hook=unique, parse_constant=finite).raw_decode(
            tail
        )
        require(tail[end:].startswith(";\nconst status=document.getElementById('status');"))
        require(isinstance(payload, dict))
        require(set(payload) == {"title", "mode", "view", "style", "controls", "images"})
        require(isinstance(payload["title"], str) and len(payload["title"]) <= 2000)
        require(payload["mode"] in {"live", "offline"})
        view, style = payload["view"], payload["style"]
        require(isinstance(view, dict) and set(view) == {"center", "zoom", "pitch", "bearing"})
        center = view["center"]
        require(isinstance(center, list) and len(center) == 2)
        require(
            all(
                type(x) in {int, float}
                for x in [*center, view["zoom"], view["pitch"], view["bearing"]]
            )
        )
        require(-180 <= center[0] <= 180 and -90 <= center[1] <= 90)
        require(0 <= view["zoom"] <= 24 and 0 <= view["pitch"] <= 85)
        require(isinstance(style, dict) and set(style) == {"version", "sources", "layers"})
        require(style["version"] == 8 and isinstance(style["sources"], dict))
        require(1 <= len(style["sources"]) <= 128)
        source_keys = {
            "type",
            "data",
            "tiles",
            "tileSize",
            "scheme",
            "minzoom",
            "maxzoom",
            "bounds",
            "attribution",
            "cluster",
            "clusterRadius",
            "clusterMaxZoom",
            "generateId",
            "promoteId",
            "lineMetrics",
            "tolerance",
            "buffer",
        }
        dependencies = {item["id"]: item for item in manifest["dependencies"]}
        require(set(dependencies) == set(style["sources"]), "source_binding_mismatch")
        for identity, source in style["sources"].items():
            require(isinstance(source, dict) and set(source) <= source_keys)
            dependency = dependencies[identity]
            require(
                sha256(canonical_json_bytes(source)).hexdigest() == dependency["checksumSha256"],
                "source_binding_mismatch",
            )
            if source.get("type") == "geojson":
                data = source.get("data")
                require(
                    isinstance(data, dict) and data.get("type") in {"Feature", "FeatureCollection"}
                )
                features = data.get("features") if data["type"] == "FeatureCollection" else [data]
                require(isinstance(features, list) and len(features) <= 100000)
                require(
                    all(
                        isinstance(feature, dict)
                        and feature.get("type") == "Feature"
                        and isinstance(feature.get("properties"), (dict, type(None)))
                        and isinstance(feature.get("geometry"), (dict, type(None)))
                        for feature in features
                    )
                )
                require("tiles" not in source and dependency["mode"] == "embedded")
            elif source.get("type") == "raster":
                require(payload["mode"] == "live" and "data" not in source)
                require(
                    source.get("tiles") == dependency["accessUrls"]
                    and dependency["mode"] == "live",
                    "source_binding_mismatch",
                )
            else:
                reject("unsupported_native_source")
        layers = style["layers"]
        require(isinstance(layers, list) and 1 <= len(layers) <= 1024)
        ids: set[str] = set()
        point_image_ids: set[str] = set()
        for layer in layers:
            require(
                isinstance(layer, dict)
                and set(layer)
                <= {
                    "id",
                    "type",
                    "source",
                    "source-layer",
                    "minzoom",
                    "maxzoom",
                    "filter",
                    "layout",
                    "paint",
                }
            )
            require(isinstance(layer.get("id"), str) and layer["id"] not in ids)
            ids.add(layer["id"])
            require(
                layer.get("type")
                in {
                    "background",
                    "fill",
                    "line",
                    "circle",
                    "raster",
                    "heatmap",
                    "fill-extrusion",
                    "symbol",
                }
            )
            require(layer.get("source") in style["sources"] or layer.get("type") == "background")
            if layer.get("type") == "symbol":
                if isinstance(layer.get("layout"), dict) and "icon-image" in layer["layout"]:
                    require(style["sources"][layer["source"]].get("type") == "geojson")
                    point_image_ids.update(_point_symbol_images(layer))
                else:
                    require(
                        isinstance(layer.get("layout"), dict) and "text-field" in layer["layout"],
                        "unsupported_label_assets",
                    )
        controls = payload["controls"]
        require(isinstance(controls, list) and 1 <= len(controls) <= 128)
        for control in controls:
            require(isinstance(control, dict) and set(control) == {"title", "ids", "visible"})
            require(isinstance(control["title"], str) and type(control["visible"]) is bool)
            require(
                isinstance(control["ids"], list)
                and control["ids"]
                and all(identity in ids for identity in control["ids"])
            )
        images = payload["images"]
        require(isinstance(images, list) and len(images) <= 128)
        image_ids: set[str] = set()
        for image in images:
            require(
                isinstance(image, dict)
                and set(image) == {"id", "width", "height", "data", "pixelRatio"}
            )
            require(isinstance(image["id"], str) and image["id"] not in image_ids)
            image_ids.add(image["id"])
            require(image["width"] == 64 and image["height"] == 64 and len(image["data"]) == 16384)
            require(all(type(x) is int and 0 <= x <= 255 for x in image["data"]))
            require(type(image["pixelRatio"]) in {int, float} and 1 <= image["pixelRatio"] <= 8)
            if image["id"] in point_image_ids:
                require(image["pixelRatio"] == 2, "unsupported_point_symbol_assets")
        require(point_image_ids <= image_ids, "missing_point_symbol_assets")
        build = manifest["build"]
        inputs = {"payload": payload, "runtime": build["runtime"]}
        if manifest.get("styleDependencies"):
            inputs["styleDependencies"] = manifest["styleDependencies"]
        require(
            sha256(canonical_json_bytes(inputs)).hexdigest() == build["inputChecksumSha256"],
            "compiler_input_binding_mismatch",
        )
        return cast(dict[str, Any], payload)
    except NativePayloadUnsupported:
        raise
    except (
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        RecursionError,
        OverflowError,
    ) as error:
        raise NativePayloadUnsupported("unsupported_portable_payload") from error


def native_project_module(payload: dict[str, Any], metadata: dict[str, Any]) -> bytes:
    """Host-supplied MapLibre, data only: no retained HTML/runtime/style execution."""

    def literal(value: Any) -> str:
        return (
            json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            .replace("<", "\\u003c")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        )

    return (
        "// OpenGeo native portable map v1; host supplies MapLibre and its CSS.\n"
        f"export const artifact=Object.freeze({literal(metadata)});\n"
        f"const publication={literal(payload)};\n"
        + r"""
const clone = (value) => JSON.parse(JSON.stringify(value));
function createView({
  maplibre,
  height = 600,
  width = "100%",
  invalidation,
  signal,
  document: ownerDocument = globalThis.document
} = {}) {
  if (!maplibre?.Map || !ownerDocument?.createElement) throw Error("Host MapLibre and document \
are required; use artifact.iframe_url for the isolated viewer.");
  const root = ownerDocument.createElement("div"), canvas = ownerDocument.createElement("div"),
  tools = ownerDocument.createElement("div"), credit = ownerDocument.createElement("small");
  root.className = "opengeo-native-map";
  root.style.font = "inherit";
  root.style.color = "inherit";
  root.style.width = typeof width === "number" ? `${width}px` : String(width);
  canvas.className = "opengeo-native-map-canvas";
  canvas.style.height = typeof height === "number" ? `${height}px` : String(height);
  tools.className = "opengeo-native-map-controls";
  credit.textContent = `${artifact.attribution} \xB7 ${artifact.license}`;
  root.append(canvas, tools, credit);
  let disposed = false, loaded = false, selection = [], resizeObserver;
  const listeners = [], pending = [];
  const emit = (type, detail) => root.dispatchEvent(new (ownerDocument.defaultView?.CustomEvent ??
  globalThis.CustomEvent)(type, { detail }));
  const map = new maplibre.Map({
    container: canvas,
    style: { ...clone(publication.style), layers: publication.style.layers.filter((layer) => layer.
    type === "background").map(clone) },
    ...clone(publication.view),
    attributionControl: true,
    transformRequest: (url) => ({ url, credentials: "omit" })
  });
  const check = () => {
    if (disposed) throw Error("This map is disposed.");
  };
  const camera = () => ({ center: map.getCenter().toArray(), zoom: map.getZoom(),
    pitch: map.getPitch(),
  bearing: map.getBearing() });
  const listen = (type, fn) => {
    map.on(type, fn);
    listeners.push([type, fn]);
  };
  const layers = new Set(publication.style.layers.map((layer) => layer.id));
  const visibility = new Map(publication.style.layers.map((layer) => [layer.id,
    layer.layout?.visibility !== "none"])), controlInputs = [];
  const syncControls = () => {
    for (const {control, input} of controlInputs) {
      const visible = control.ids.filter((id) => visibility.get(id)).length;
      input.checked = visible === control.ids.length;
      input.indeterminate = visible > 0 && !input.checked;
    }
  };
  const apply = (action) => {
    check();
    if (loaded) action();
    else pending.push(action);
  };
  const requireLayer = (id) => {
    if (!layers.has(id)) throw Error("Unknown published paint layer.");
  };
  const setLayerVisibility = (id, visible) => {
    requireLayer(id);
    if (typeof visible !== "boolean") throw TypeError("Visibility must be boolean.");
    apply(() => {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      visibility.set(id, visible);
      syncControls();
      emit("layerchange", { id, visible });
    });
  };
  const setFilter = (id, filter) => {
    requireLayer(id);
    if (filter !== null && !Array.isArray(filter)) throw TypeError("A MapLibre filter array or \
null is required.");
    const value = clone(filter);
    apply(() => {
      map.setFilter(id, value);
      emit("filterchange", { id, filter: clone(value) });
    });
  };
  const setCamera = (view) => {
    check();
    if (!view || Object.keys(view).some((key) => !["center", "zoom", "pitch", "bearing"].includes(
    key))) throw TypeError("Use center, zoom, pitch or bearing.");
    if (view.center !== void 0 && (!Array.isArray(view.center) || view.center.length !== 2 || !view.
    center.every(Number.isFinite))) throw TypeError("Invalid center.");
    for (const key of ["zoom", "pitch", "bearing"]) if (view[key] !== void 0 && !Number.isFinite(
    view[key])) throw TypeError("Invalid camera.");
    map.jumpTo(clone(view));
  };
  const setSelection = (features) => {
    check();
    if (!Array.isArray(features) || features.length > 100) throw TypeError("Selection must cont\
ain at most100 features.");
    selection = clone(features);
    emit("selectionchange", { features: clone(selection) });
  };
  listen("load", () => {
    if (disposed) return;
    for (const image of publication.images) map.addImage(image.id,
    { width: image.width, height: image.
    height, data: new Uint8Array(image.data) }, { pixelRatio: image.pixelRatio });
    for (const layer of publication.style.layers) if (layer.type !== "background") map.addLayer(
    clone(layer));
    loaded = true;
    for (const action of pending.splice(0)) action();
    emit("mapready", { camera: camera() });
  });
  listen("moveend", () => {
    if (!disposed) emit("camerachange", camera());
  });
  listen("click", (event) => {
    if (!loaded || disposed) return;
    const features = map.queryRenderedFeatures(event.point, { layers: [...layers] }).slice(0, 100).
    map((feature) => ({ id: feature.id ?? null, source: feature.source,
    sourceLayer: feature.sourceLayer ??
    null, properties: feature.properties ?? {}, geometry: feature.geometry }));
    setSelection(features);
  });
  listen("error", () => {
    if (!disposed) emit("maperror", { message: "A map resource could not load; no alternate sou\
rce was substituted." });
  });
  for (const control of publication.controls) {
    const label = ownerDocument.createElement("label"), input = ownerDocument.createElement("in\
put");
    input.type = "checkbox";
    input.checked = control.visible;
    input.addEventListener("change", () => {
      const visible = input.checked;
      control.ids.forEach((id) => setLayerVisibility(id, visible));
    });
    controlInputs.push({control, input});
    label.append(input, ownerDocument.createTextNode(` ${control.title}`));
    tools.append(label);
  }
  syncControls();
  const reset = ownerDocument.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset view";
  reset.style.font = "inherit";
  reset.addEventListener("click", () => setCamera(publication.view));
  tools.append(reset);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    resizeObserver?.disconnect();
    pending.length = 0;
    for (const [type, fn] of listeners) map.off(type, fn);
    map.remove();
    root.remove();
    emit("dispose", null);
  };
  Object.defineProperties(root, { map: { value: map }, resize: { value: () => {
    check();
    map.resize();
  } }, getCamera: { value: () => {
    check();
    return camera();
  } }, setCamera: { value: setCamera }, setFilter: { value: setFilter },
  setLayerVisibility: { value: setLayerVisibility },
  getLayers: { value: () => clone(publication.style.layers.map(({ id, type, source }) => ({ id,
  type, source }))) }, getSelection: { value: () => clone(selection) },
  setSelection: { value: setSelection },
  dispose: { value: dispose } });
  const Resize = ownerDocument.defaultView?.ResizeObserver;
  if (Resize) {
    resizeObserver = new Resize(() => {
      if (!disposed) map.resize();
    });
    resizeObserver.observe(canvas);
  }
  if (signal?.aborted) dispose();
  else signal?.addEventListener("abort", dispose, { once: true });
  if (invalidation) Promise.resolve(invalidation).then(dispose, dispose);
  return root;
}
export {
  createView
};
"""
    ).encode("utf-8")
