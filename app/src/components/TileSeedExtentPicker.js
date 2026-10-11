import maplibregl from "../lib/mapRenderer.js";

export const WEB_MERCATOR_LATITUDE_LIMIT = 85.05112878;

const EXTENT_SOURCE = "opengeo-tile-seed-extent";

export function normalizeTileSeedExtent(first, second) {
  const [firstLongitude, firstLatitude] = position(first, "first extent corner");
  const [secondLongitude, secondLatitude] = position(second, "second extent corner");
  return validateTileSeedBbox([
    roundCoordinate(Math.min(firstLongitude, secondLongitude)),
    roundCoordinate(Math.min(firstLatitude, secondLatitude)),
    roundCoordinate(Math.max(firstLongitude, secondLongitude)),
    roundCoordinate(Math.max(firstLatitude, secondLatitude))
  ]);
}

export function validateTileSeedBbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
    throw new TypeError("tile seed extent must contain four finite CRS84 coordinates");
  }
  const [west, south, east, north] = value;
  if (!(west >= -180 && west < east && east <= 180)) {
    throw new TypeError("tile seed extent must be a non-wrapping west-to-east CRS84 bbox");
  }
  if (!(south >= -WEB_MERCATOR_LATITUDE_LIMIT
    && south < north
    && north <= WEB_MERCATOR_LATITUDE_LIMIT)) {
    throw new TypeError("tile seed extent must stay within WebMercator latitude bounds");
  }
  return [west, south, east, north];
}

export function tileSeedExtentSelector({
  expectedCacheVersion,
  bbox,
  minimumTileMatrix,
  maximumTileMatrix,
  policyMinimumTileMatrix,
  policyMaximumTileMatrix
}) {
  if (!Number.isSafeInteger(expectedCacheVersion) || expectedCacheVersion < 1) {
    throw new TypeError("tile seed cache version is invalid");
  }
  for (const [name, value] of [
    ["minimum tile matrix", minimumTileMatrix],
    ["maximum tile matrix", maximumTileMatrix],
    ["policy minimum tile matrix", policyMinimumTileMatrix],
    ["policy maximum tile matrix", policyMaximumTileMatrix]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 22) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  if (policyMinimumTileMatrix > policyMaximumTileMatrix
    || minimumTileMatrix < policyMinimumTileMatrix
    || maximumTileMatrix > policyMaximumTileMatrix
    || minimumTileMatrix > maximumTileMatrix) {
    throw new TypeError("tile seed zoom interval is outside the current cache policy");
  }
  return {
    expectedCacheVersion,
    mode: "bbox",
    bbox: [...validateTileSeedBbox(bbox)],
    minimumTileMatrix,
    maximumTileMatrix
  };
}

export function TileSeedExtentPicker({policy}) {
  const root = document.createElement("section");
  root.className = "tile-seed-extent-picker";
  root.append(
    text("h6", "Map-drawn CRS84 extent"),
    text(
      "p",
      "Drag one non-wrapping extent, choose a cache-policy zoom interval, preview its exact WebMercatorQuad coordinates, then confirm separately. Drawing and previewing create no render work.",
      "project-resource-feedback"
    )
  );

  const toolbar = document.createElement("div");
  toolbar.className = "tile-seed-extent-toolbar";
  const draw = button("Draw seed extent");
  const clear = button("Clear drawn extent", "platform-button secondary");
  toolbar.append(draw, clear);

  const mapContainer = document.createElement("div");
  mapContainer.className = "tile-seed-extent-map";
  mapContainer.role = "application";
  mapContainer.ariaLabel = "CRS84 tile seed extent map";

  const fields = document.createElement("div");
  fields.className = "tile-seed-extent-fields";
  const west = numberField("West longitude", -180, 180, "any");
  const south = numberField(
    "South latitude", -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT, "any"
  );
  const east = numberField("East longitude", -180, 180, "any");
  const north = numberField(
    "North latitude", -WEB_MERCATOR_LATITUDE_LIMIT, WEB_MERCATOR_LATITUDE_LIMIT, "any"
  );
  const minimumZoom = numberField(
    "Minimum zoom", policy.minimumTileMatrix, policy.maximumTileMatrix, "1",
    policy.minimumTileMatrix
  );
  const maximumZoom = numberField(
    "Maximum zoom", policy.minimumTileMatrix, policy.maximumTileMatrix, "1",
    policy.minimumTileMatrix
  );
  fields.append(
    west.label, south.label, east.label, north.label, minimumZoom.label, maximumZoom.label
  );
  const status = text(
    "p",
    "Choose Draw seed extent, then drag from one corner to the opposite corner.",
    "tile-seed-extent-status"
  );
  status.ariaLive = "polite";
  root.append(toolbar, mapContainer, fields, status);

  let map;
  let loaded = false;
  let drawMode = false;
  let dragStart = null;
  let currentBbox = null;
  let removed = false;
  let lifecycleObserver;

  requestAnimationFrame(function initializeWhenVisible() {
    if (removed) return;
    if (!root.isConnected || mapContainer.clientWidth === 0 || mapContainer.clientHeight === 0) {
      requestAnimationFrame(initializeWhenVisible);
      return;
    }
    map = new maplibregl.Map({
      container: mapContainer,
      style: {
        version: 8,
        sources: {},
        layers: [{
          id: "opengeo-tile-seed-background",
          type: "background",
          paint: {"background-color": "#102333"}
        }]
      },
      center: [0, 0],
      zoom: 1,
      minZoom: 0,
      maxZoom: 10,
      renderWorldCopies: false,
      attributionControl: false,
      transformRequest: (url) => ({url, credentials: "omit"})
    });
    lifecycleObserver = new MutationObserver(() => {
      if (!root.isConnected) destroy();
    });
    lifecycleObserver.observe(document.body, {childList: true, subtree: true});
    map.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-right");
    let initialized = false;
    const initializeMap = () => {
      if (initialized) return;
      initialized = true;
      loaded = true;
      mapContainer.dataset.ready = "true";
      map.addSource(EXTENT_SOURCE, {type: "geojson", data: extentCollection(null)});
      map.addLayer({
        id: "opengeo-tile-seed-extent-fill",
        type: "fill",
        source: EXTENT_SOURCE,
        paint: {"fill-color": "#f5b642", "fill-opacity": 0.28}
      });
      map.addLayer({
        id: "opengeo-tile-seed-extent-line",
        type: "line",
        source: EXTENT_SOURCE,
        paint: {"line-color": "#ffd477", "line-width": 3}
      });
      syncExtent();
      status.textContent = "Map ready. Choose Draw seed extent, then drag one bounded rectangle.";
    };
    map.once("style.load", initializeMap);
    map.once("load", initializeMap);
    requestAnimationFrame(() => {
      map.resize();
      if (map.isStyleLoaded()) initializeMap();
    });
    map.on("mousedown", (event) => {
      if (!drawMode) return;
      event.preventDefault();
      dragStart = mapPosition(event.lngLat);
      setBbox(null);
      status.textContent = "Drag to the opposite corner, then release to seal the CRS84 extent.";
    });
    map.on("mousemove", (event) => {
      if (!drawMode || dragStart === null) return;
      try {
        currentBbox = normalizeTileSeedExtent(dragStart, mapPosition(event.lngLat));
        syncExtent();
      } catch {
        currentBbox = null;
        syncExtent();
      }
    });
    map.on("mouseup", (event) => {
      if (!drawMode || dragStart === null) return;
      try {
        setBbox(normalizeTileSeedExtent(dragStart, mapPosition(event.lngLat)));
        status.textContent = "Extent captured. Review its exact coordinates and zoom interval before previewing.";
      } catch (error) {
        setBbox(null);
        status.textContent = `${error.message}. Draw a larger non-wrapping extent.`;
      }
      dragStart = null;
      setDrawMode(false);
    });
  });

  draw.addEventListener("click", () => {
    if (!map || !loaded) {
      status.textContent = "The extent map is still loading.";
      return;
    }
    dragStart = null;
    setDrawMode(true);
    status.textContent = "Drag from one extent corner to the opposite corner.";
  });
  clear.addEventListener("click", () => {
    dragStart = null;
    setDrawMode(false);
    setBbox(null);
    status.textContent = "Extent cleared. Draw a new non-wrapping CRS84 rectangle.";
  });
  for (const control of [west.control, south.control, east.control, north.control]) {
    control.addEventListener("change", () => {
      try {
        setBbox(validateTileSeedBbox([
          Number(west.control.value),
          Number(south.control.value),
          Number(east.control.value),
          Number(north.control.value)
        ]));
        status.textContent = "Exact coordinate extent accepted. Previewing remains read-only.";
      } catch (error) {
        currentBbox = null;
        syncExtent();
        status.textContent = `${error.message}. No render work was created.`;
      }
    });
  }

  root.getSelector = () => tileSeedExtentSelector({
    expectedCacheVersion: policy.versionNumber,
    bbox: currentBbox ?? [
      Number(west.control.value),
      Number(south.control.value),
      Number(east.control.value),
      Number(north.control.value)
    ],
    minimumTileMatrix: Number(minimumZoom.control.value),
    maximumTileMatrix: Number(maximumZoom.control.value),
    policyMinimumTileMatrix: policy.minimumTileMatrix,
    policyMaximumTileMatrix: policy.maximumTileMatrix
  });
  root.__destroy = destroy;
  return root;

  function destroy() {
    if (removed) return;
    removed = true;
    lifecycleObserver?.disconnect();
    map?.remove();
    map = undefined;
  }

  function setDrawMode(value) {
    drawMode = value;
    draw.dataset.active = value ? "true" : "false";
    if (!map) return;
    if (value) map.dragPan.disable();
    else map.dragPan.enable();
    map.getCanvas().style.cursor = value ? "crosshair" : "";
  }

  function setBbox(value) {
    currentBbox = value === null ? null : [...validateTileSeedBbox(value)];
    const values = currentBbox ?? ["", "", "", ""];
    for (const [field, coordinate] of [
      [west, values[0]], [south, values[1]], [east, values[2]], [north, values[3]]
    ]) {
      field.control.value = String(coordinate);
    }
    syncExtent();
  }

  function syncExtent() {
    if (!loaded) return;
    map.getSource(EXTENT_SOURCE).setData(extentCollection(currentBbox));
  }
}

function position(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) {
    throw new TypeError(`${label} is invalid`);
  }
  const [longitude, latitude] = value;
  if (longitude < -180 || longitude > 180
    || latitude < -WEB_MERCATOR_LATITUDE_LIMIT
    || latitude > WEB_MERCATOR_LATITUDE_LIMIT) {
    throw new TypeError(`${label} is outside WebMercator`);
  }
  return value;
}

function mapPosition(value) {
  return [
    Math.max(-180, Math.min(180, value.lng)),
    Math.max(-WEB_MERCATOR_LATITUDE_LIMIT, Math.min(WEB_MERCATOR_LATITUDE_LIMIT, value.lat))
  ];
}

function roundCoordinate(value) {
  return Number(value.toFixed(7));
}

function extentCollection(bbox) {
  if (bbox === null) return {type: "FeatureCollection", features: []};
  const [west, south, east, north] = bbox;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[
          [west, south], [east, south], [east, north], [west, north], [west, south]
        ]]
      }
    }]
  };
}

function numberField(labelText, minimum, maximum, step, value = "") {
  const label = document.createElement("label");
  label.textContent = labelText;
  const control = document.createElement("input");
  control.type = "number";
  control.min = String(minimum);
  control.max = String(maximum);
  control.step = step;
  control.value = String(value);
  control.ariaLabel = labelText;
  label.append(control);
  return {label, control};
}

function button(value, className = "platform-button") {
  const control = text("button", value, className);
  control.type = "button";
  return control;
}

function text(tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
