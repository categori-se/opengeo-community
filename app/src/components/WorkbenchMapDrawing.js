import {canClosePolygon, mapAuthoringPreview} from "../lib/mapAuthoringPreview.js";
import {createTemporaryAnnotation} from "../lib/temporaryAnnotations.js";
import {addKmlPlace, createPlacesDocument, parseAuthoringGeometry} from "../lib/kmlPlaces.js";
import {FEATURE_QUERY_LIMITS} from "../lib/featureQuery.js";
import {featureQueryDraft} from "../lib/workbenchFeatureQuery.js";

const DEFAULT_AUTHORING_EXTENT = Object.freeze([13.4, 52.5, 13.5, 52.6]);

export function normalizeWgs84CaptureExtent(value, fallback = DEFAULT_AUTHORING_EXTENT) {
  const safeFallback = validGeographicBounds(fallback)
    ? fallback.map((coordinate) => boundedCoordinate(coordinate, 0))
    : [...DEFAULT_AUTHORING_EXTENT];
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) {
    return [...safeFallback];
  }

  const rawWest = Number(value[0]);
  const rawSouth = Number(value[1]);
  const rawEast = Number(value[2]);
  const rawNorth = Number(value[3]);
  const south = Math.max(-90, Math.min(90, Math.min(rawSouth, rawNorth)));
  const north = Math.max(-90, Math.min(90, Math.max(rawSouth, rawNorth)));
  if (!(south < north)) return [...safeFallback];

  let span = rawEast - rawWest;
  if (!(span > 0)) span = ((span % 360) + 360) % 360;
  if (!(span > 0) || span >= 360) {
    return [-180, boundedCoordinate(south, safeFallback[1]), 180, boundedCoordinate(north, safeFallback[3])];
  }

  const midpoint = rawWest + (span / 2);
  const worldOffset = 360 * Math.floor((midpoint + 180) / 360);
  const west = rawWest - worldOffset;
  const east = west + span;
  // One ordered WGS84 bounding box cannot represent a wrapped viewport. Use
  // the whole longitude range so a protected copy never silently omits the
  // visible portion on the other side of the antimeridian.
  if (west < -180 || east > 180) {
    return [-180, boundedCoordinate(south, safeFallback[1]), 180, boundedCoordinate(north, safeFallback[3])];
  }
  return [
    boundedCoordinate(west, safeFallback[0]),
    boundedCoordinate(south, safeFallback[1]),
    boundedCoordinate(east, safeFallback[2]),
    boundedCoordinate(north, safeFallback[3])
  ];
}

export function boundedCoordinate(value, fallback) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : fallback;
}

export function validGeographicBounds(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every(Number.isFinite)
    && value[0] >= -180 && value[0] < value[2] && value[2] <= 180
    && value[1] >= -90 && value[1] < value[3] && value[3] <= 90;
}

export function defaultAuthoredKmlStyle(kind, color) {
  if (!/^[0-9a-fA-F]{8}$/.test(color)) throw Object.assign(new Error("places_style_color_invalid"), {code: "places_style_color_invalid"});
  if (kind === "Point") return {icon: {color, scale: 1}};
  if (kind === "LineString") return {line: {color, width: 3}};
  return {line: {color, width: 2}, polygon: {color, fill: true, outline: true}};
}

export function findNewestKmlPlace(previous, next) {
  const known = new Set();
  const collect = (children) => {
    for (const child of children ?? []) {
      known.add(child.id);
      if (child.kind === "folder") collect(child.children);
    }
  };
  collect(previous?.children);
  let created = null;
  const locate = (children) => {
    for (const child of children ?? []) {
      if (!known.has(child.id)) return child;
      if (child.kind === "folder") {
        const nested = locate(child.children);
        if (nested) return nested;
      }
    }
    return null;
  };
  created = locate(next?.children);
  return created;
}

// Workbench owns surrounding editors, measurement and persistence.
// Drawing uses those existing actions without importing the Workbench.
export function createWorkbenchMapDrawing({
  actionButton,
  activeLayer,
  applyKmlPlacesDocument,
  cancelTemporaryEdit,
  closeImageOverlayEditor,
  closeShapeEditor,
  editingKmlLayerId,
  emptyKmlReport,
  invalidateFeatureQueryResult,
  isMobileWorkbenchViewport,
  pauseFlightSimulation,
  persistTemporaryWork,
  propertyFields,
  removeMapLayer,
  setStatus,
  syncMeasureLayer,
  textElement
}) {
  function beginMapAuthoring(context, kind, {target = "places"} = {}) {
    closeShapeEditor(context);
    closeImageOverlayEditor(context);
    const {state} = context;
    pauseFlightSimulation(context, {render: false, announce: false});
    cancelQueryDrawing(context, {render: false, announce: false});
    cancelMapAuthoring(context, {render: false, announce: false});
    cancelTemporaryEdit(context, {render: false, announce: false});
    state.mapAuthoring = {kind, coordinates: [], target};
    state.measureMode = false;
    state.editingMeasurementId = null;
    state.measurePoints = [];
    syncMeasureLayer(state);
    state.leftOpen = target === "temporary" ? true : !isMobileWorkbenchViewport();
    state.rightOpen = false;
    state.leftPanelMode = "layers";
    state.kmlContentsOpen = target !== "temporary";
    state.selectedKmlPlaceId = null;
    if (target === "places" && !state.kmlPlaces) {
      state.mapAuthoringCreatedKmlPlaces = true;
      state.kmlInterchangeReport = emptyKmlReport();
      applyKmlPlacesDocument(context, createPlacesDocument(), mapAuthoringInstruction(state.mapAuthoring));
    }
    setStatus(context, mapAuthoringInstruction(state.mapAuthoring));
    syncMapAuthoringLayer(state);
    context.render();
  }

  function polygonOriginHit(state, draft, point) {
    const map = state.map;
    if (!map || map.isMoving?.()) return false;
    const canvas = map.getCanvas();
    return canClosePolygon(draft, point, coordinate => map.project(coordinate), 12,
      {width: canvas.clientWidth, height: canvas.clientHeight});
  }

  function addMapAuthoringPoint(context, lngLat, point) {
    const {state} = context;
    if (!state.mapAuthoring) return;
    if (polygonOriginHit(state, state.mapAuthoring, point)) {
      finishMapAuthoring(context);
      return;
    }
    state.mapAuthoring.hover = null;
    state.mapAuthoring.canClose = false;
    state.mapAuthoring.coordinates.push([
      boundedCoordinate(lngLat?.lng, 0),
      boundedCoordinate(lngLat?.lat, 0)
    ]);
    syncMapAuthoringLayer(state);
    if (state.mapAuthoring.kind === "Point") {
      finishMapAuthoring(context);
      return;
    }
    setStatus(context, mapAuthoringInstruction(state.mapAuthoring));
    context.render();
  }

  function undoMapAuthoringPoint(context) {
    const {state} = context;
    if (!state.mapAuthoring?.coordinates.length) return;
    state.mapAuthoring.coordinates.pop();
    syncMapAuthoringLayer(state);
    setStatus(context, mapAuthoringInstruction(state.mapAuthoring));
    context.render();
  }

  function finishMapAuthoring(context) {
    const {state} = context;
    const draft = state.mapAuthoring;
    if (!draft || !mapAuthoringCanFinish(draft)) return;
    const kind = draft.kind;
    if (draft.target === "temporary") {
      try {
        const entry = createTemporaryAnnotation({kind, coordinates: draft.coordinates});
        state.mapAuthoring = null;
        state.primaryAuthoringKind = null;
        syncMapAuthoringLayer(state);
        context.addLayer(entry.layer, entry.geojson, {panelAfterAdd: "temporary"});
        persistTemporaryWork(context);
        state.leftPanelMode = "layers";
        state.leftOpen = true;
        state.rightOpen = true;
        setStatus(context, `${entry.layer.title} added as browser-only temporary work. It expires after 24 hours and is excluded from authoritative saves.`);
        context.render();
      } catch (error) {
        state.mapAuthoring = null;
        syncMapAuthoringLayer(state);
        setStatus(context, `Temporary annotation rejected safely (${error?.code ?? "invalid_annotation"}).`);
        context.render();
      }
      return;
    }
    if (kind === "image-overlay") {
      const [[firstLongitude, firstLatitude], [secondLongitude, secondLatitude]] = draft.coordinates;
      state.overlayExtentDraft = [
        Math.min(firstLongitude, secondLongitude),
        Math.min(firstLatitude, secondLatitude),
        Math.max(firstLongitude, secondLongitude),
        Math.max(firstLatitude, secondLatitude)
      ];
    } else {
      const coordinates = draft.coordinates.map(([longitude, latitude]) => [longitude, latitude]);
      if (kind === "Polygon") coordinates.push([...coordinates[0]]);
      const name = kind === "LineString" ? "Path" : kind;
      try {
        const next = addKmlPlace(state.kmlPlaces, state.kmlPlaces.id, {
          kind: "placemark", name,
          geometry: parseAuthoringGeometry(kind, coordinates.map((coordinate) => coordinate.join(",")).join(" ")),
          altitudeMode: "clampToGround", tessellate: kind !== "Point",
          style: defaultAuthoredKmlStyle(kind, "ff00a5f5")
        });
        state.selectedKmlPlaceId = findNewestKmlPlace(state.kmlPlaces, next).id;
        state.mapAuthoring = null;
        state.mapAuthoringCreatedKmlPlaces = false;
        state.primaryAuthoringKind = null;
        state.authoringCoordinateDraft = null;
        syncMapAuthoringLayer(state);
        applyKmlPlacesDocument(context, next, `${name} added to the map. You can edit its shape or details at any time.`);
        return;
      } catch (error) {
        setStatus(context, `The shape is still a draft (${error?.code ?? "invalid geometry"}). Adjust its points and try again.`);
        return;
      }
    }
    state.mapAuthoring = null;
    state.primaryAuthoringKind = kind;
    if (isMobileWorkbenchViewport()) state.leftOpen = true;
    syncMapAuthoringLayer(state);
    setStatus(context, kind === "image-overlay"
      ? "Overlay extent captured. Choose a local image and confirm its details."
      : `${kind === "LineString" ? "Path" : kind} geometry captured. Name it and add it to the KML layer.`);
    context.render();
    requestAnimationFrame(() => {
      const selector = kind === "image-overlay"
        ? '.gis-overlay-authoring [data-kml-overlay-field="name"]'
        : '.gis-place-authoring [data-kml-authoring-field="name"]';
      context.shell.querySelector(selector)?.focus();
    });
  }

  function cancelMapAuthoring(context, {render = true, announce = true} = {}) {
    const {state} = context;
    const wasActive = Boolean(state.mapAuthoring);
    state.mapAuthoring = null;
    syncMapAuthoringLayer(state);
    if (wasActive && state.mapAuthoringCreatedKmlPlaces) {
      const placeholder = context.layers.find(({layerId}) => layerId === editingKmlLayerId(context));
      if (placeholder) {
        removeMapLayer(state, placeholder.layerId);
        context.layers.splice(context.layers.indexOf(placeholder), 1);
        context.dataByLayerId.delete(placeholder.layerId);
      }
      state.kmlPlaces = null;
      state.kmlInterchangeReport = null;
      state.mapAuthoringCreatedKmlPlaces = false;
    }
    if (wasActive && context.layers.length === 0) state.leftPanelMode = "layers";
    if (announce && wasActive) setStatus(context, "Map drawing canceled.");
    if (render && wasActive) context.render();
  }

  function mapAuthoringCanFinish(draft) {
    const minimum = draft?.kind === "LineString" || draft?.kind === "image-overlay"
      ? 2
      : draft?.kind === "Polygon"
        ? 3
        : 1;
    return (draft?.coordinates?.length ?? 0) >= minimum;
  }

  function mapAuthoringInstruction(draft) {
    const count = draft?.coordinates?.length ?? 0;
    const temporary = draft?.target === "temporary" ? "Temporary " : "";
    if (draft?.kind === "Point") return `${temporary}point tool active · click the map to place a point.`;
    if (draft?.kind === "LineString") return `${temporary}path tool active · ${count ? `${count} ${count === 1 ? "vertex" : "vertices"} · ` : ""}click to add vertices, then Finish path.`;
    if (draft?.kind === "Polygon") return `${temporary}polygon tool active · ${count ? `${count} ${count === 1 ? "vertex" : "vertices"} · ` : ""}click at least three corners, then click the first point or Finish polygon.`;
    return `Image overlay tool active · ${count ? "click the opposite corner" : "click the first extent corner"}.`;
  }

  function syncMapAuthoringLayer(state) {
    const map = state.map;
    if (!map?.isStyleLoaded()) return;
    const sourceId = "opengeo-authoring-source";
    const fillId = "opengeo-authoring-fill";
    const lineId = "opengeo-authoring-line";
    const pointId = "opengeo-authoring-points";
    map.getCanvas().style.cursor = state.mapAuthoring ? (state.mapAuthoring.canClose ? "pointer" : "crosshair") : "";
    const data = mapAuthoringPreview(state.mapAuthoring);
    if (map.getSource(sourceId)) { map.getSource(sourceId).setData(data); return; }
    if (!state.mapAuthoring) return;
    map.addSource(sourceId, {type: "geojson", data});
    map.addLayer({id: fillId, type: "fill", source: sourceId, filter: ["==", ["geometry-type"], "Polygon"], paint: {"fill-color": "#38bdf8", "fill-opacity": 0.22}});
    map.addLayer({id: lineId, type: "line", source: sourceId, filter: ["!=", ["geometry-type"], "Point"], paint: {"line-color": "#38bdf8", "line-width": 3, "line-dasharray": [2, 1]}});
    map.addLayer({id: pointId, type: "circle", source: sourceId, filter: ["==", ["geometry-type"], "Point"], paint: {"circle-color": ["case", ["boolean", ["get", "close"], false], "#4ade80", "#f8fafc"], "circle-radius": ["case", ["boolean", ["get", "close"], false], 9, 6], "circle-stroke-color": "#0284c7", "circle-stroke-width": 3}});
  }

  function beginQueryDrawing(context, kind, replaceIndex = null) {
    const {state} = context;
    cancelMapAuthoring(context, {render: false, announce: false});
    cancelTemporaryEdit(context, {render: false, announce: false});
    state.measureMode = false;
    state.editingMeasurementId = null;
    state.measurePoints = [];
    syncMeasureLayer(state);
    state.queryDrawing = {kind, coordinates: [], replaceIndex};
    state.activePanel = "query";
    state.rightOpen = true;
    state.queryError = null;
    syncQueryGeometryLayer(state);
    setStatus(context, queryDrawingInstruction(state.queryDrawing));
    context.render();
  }

  function addQueryDrawingPoint(context, lngLat, point) {
    const {state} = context;
    if (!state.queryDrawing) return;
    if (polygonOriginHit(state, state.queryDrawing, point)) {
      finishQueryDrawing(context);
      return;
    }
    state.queryDrawing.coordinates.push([
      boundedCoordinate(lngLat?.lng, 0),
      boundedCoordinate(lngLat?.lat, 0)
    ]);
    syncQueryGeometryLayer(state);
    if (state.queryDrawing.kind === "Point") {
      finishQueryDrawing(context);
      return;
    }
    setStatus(context, queryDrawingInstruction(state.queryDrawing));
    context.render();
  }

  function undoQueryDrawingPoint(context) {
    if (!context.state.queryDrawing?.coordinates.length) return;
    context.state.queryDrawing.coordinates.pop();
    syncQueryGeometryLayer(context.state);
    setStatus(context, queryDrawingInstruction(context.state.queryDrawing));
    context.render();
  }

  function finishQueryDrawing(context) {
    const {state} = context;
    const drawing = state.queryDrawing;
    if (!drawing || !queryDrawingCanFinish(drawing)) return;
    const layer = activeLayer(context);
    if (!layer?.datasetId) {
      cancelQueryDrawing(context, {render: false, announce: false});
      setStatus(context, "The query selection was canceled because its governed layer is no longer active.");
      context.render();
      return;
    }
    const coordinates = drawing.coordinates.map((coordinate) => [...coordinate]);
    let geometry;
    if (drawing.kind === "Point") geometry = {type: "Point", coordinates: coordinates[0]};
    else if (drawing.kind === "MultiPoint") geometry = {type: "MultiPoint", coordinates};
    else if (drawing.kind === "LineString") geometry = {type: "LineString", coordinates};
    else if (drawing.kind === "Box") {
      const [[firstLongitude, firstLatitude], [secondLongitude, secondLatitude]] = coordinates;
      const west = Math.min(firstLongitude, secondLongitude);
      const east = Math.max(firstLongitude, secondLongitude);
      const south = Math.min(firstLatitude, secondLatitude);
      const north = Math.max(firstLatitude, secondLatitude);
      if (west === east || south === north) {
        setStatus(context, "A box selection needs two different map corners.");
        return;
      }
      geometry = {
        type: "Polygon",
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
      };
    } else geometry = {type: "Polygon", coordinates: [[...coordinates, coordinates[0]]]};
    const draft = featureQueryDraft(state, layer, propertyFields(
      context.dataByLayerId.get(layer.layerId)
    ));
    const step = {kind: "spatial", relation: "intersects", geometry, buffer_meters: 0};
    let capacityError = false;
    if (Number.isInteger(drawing.replaceIndex) && draft.steps[drawing.replaceIndex]?.kind === "spatial") {
      const previous = draft.steps[drawing.replaceIndex];
      step.relation = previous.relation;
      step.buffer_meters = previous.buffer_meters;
      draft.steps.splice(drawing.replaceIndex, 1, step);
    } else if (draft.steps.length < FEATURE_QUERY_LIMITS.maximumSteps) {
      draft.steps.push(step);
    } else {
      capacityError = true;
    }
    state.queryDrawing = null;
    invalidateFeatureQueryResult(context);
    if (capacityError) state.queryError = "maximum_query_steps_reached";
    syncQueryGeometryLayer(state);
    const selectionLabel = drawing.kind === "Box" ? "Box" : geometry.type;
    setStatus(context, `${selectionLabel} query selection captured. Run the query to link map and table results.`);
    context.render();
  }

  function useVisibleQueryArea(context) {
    const layer = activeLayer(context);
    if (!layer?.datasetId) {
      setStatus(context, "Select a governed layer before adding the visible map area to a query.");
      return;
    }
    const bounds = context.state.map?.getBounds?.();
    if (!bounds) {
      setStatus(context, "The visible map area is unavailable until the map is ready.");
      return;
    }
    const west = Math.max(-180, boundedCoordinate(bounds.getWest(), -180));
    const south = Math.max(-90, boundedCoordinate(bounds.getSouth(), -90));
    const east = Math.min(180, boundedCoordinate(bounds.getEast(), 180));
    const north = Math.min(90, boundedCoordinate(bounds.getNorth(), 90));
    if (east <= west || north <= south) {
      setStatus(context, "Visible-area queries cannot cross the antimeridian; draw a bounded polygon instead.");
      return;
    }
    const draft = featureQueryDraft(context.state, layer, propertyFields(
      context.dataByLayerId.get(layer.layerId)
    ));
    const step = {
      kind: "spatial",
      relation: "intersects",
      geometry: {
        type: "Polygon",
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
      },
      buffer_meters: 0
    };
    const existing = draft.steps.findIndex(({kind}) => kind === "spatial");
    let capacityError = false;
    if (existing >= 0) draft.steps.splice(existing, 1, step);
    else if (draft.steps.length < FEATURE_QUERY_LIMITS.maximumSteps) draft.steps.push(step);
    else capacityError = true;
    invalidateFeatureQueryResult(context);
    if (capacityError) context.state.queryError = "maximum_query_steps_reached";
    setStatus(context, "Visible map area added as a reproducible box query condition.");
    context.render();
  }

  function cancelQueryDrawing(context, {render = true, announce = true} = {}) {
    const wasActive = Boolean(context.state.queryDrawing);
    context.state.queryDrawing = null;
    syncQueryGeometryLayer(context.state);
    if (wasActive && announce) setStatus(context, "Query drawing canceled.");
    if (wasActive && render) context.render();
  }

  function queryDrawingCanFinish(drawing) {
    const minimum = ["LineString", "Box"].includes(drawing?.kind)
      ? 2
      : drawing?.kind === "Polygon"
        ? 3
        : 1;
    return (drawing?.coordinates?.length ?? 0) >= minimum;
  }

  function queryDrawingInstruction(drawing) {
    const count = drawing?.coordinates?.length ?? 0;
    if (drawing?.kind === "Point") return "Point query active · click the map to select a location.";
    if (drawing?.kind === "LineString") return `Line query active · ${count} ${count === 1 ? "vertex" : "vertices"} · add at least two, then finish.`;
    if (drawing?.kind === "MultiPoint") return `Multiple-point query active · ${count} ${count === 1 ? "point" : "points"} · add locations, then finish.`;
    if (drawing?.kind === "Box") return `Box query active · ${count ? "click the opposite corner, then finish" : "click the first corner"}.`;
    return `Polygon query active · ${count} ${count === 1 ? "vertex" : "vertices"} · add at least three, then click the first point or finish.`;
  }

  function syncQueryGeometryLayer(state) {
    const map = state.map;
    if (!map?.isStyleLoaded()) return;
    const sourceId = "opengeo-query-drawing-source";
    const layerIds = ["opengeo-query-drawing-fill", "opengeo-query-drawing-line", "opengeo-query-drawing-points"];
    for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    const drawing = state.queryDrawing;
    if (!drawing?.coordinates.length) return;
    const features = drawing.coordinates.map((coordinate) => ({
      type: "Feature",
      properties: {kind: "vertex"},
      geometry: {type: "Point", coordinates: coordinate}
    }));
    if (drawing.coordinates.length >= 2) features.push({
      type: "Feature",
      properties: {kind: "edge"},
      geometry: {type: "LineString", coordinates: drawing.coordinates}
    });
    if (drawing.kind === "Polygon" && drawing.coordinates.length >= 3) features.push({
      type: "Feature",
      properties: {kind: "area"},
      geometry: {type: "Polygon", coordinates: [[...drawing.coordinates, drawing.coordinates[0]]]}
    });
    if (drawing.kind === "Box" && drawing.coordinates.length >= 2) {
      const [[firstLongitude, firstLatitude], [secondLongitude, secondLatitude]] = drawing.coordinates;
      const west = Math.min(firstLongitude, secondLongitude);
      const east = Math.max(firstLongitude, secondLongitude);
      const south = Math.min(firstLatitude, secondLatitude);
      const north = Math.max(firstLatitude, secondLatitude);
      features.push({
        type: "Feature",
        properties: {kind: "area"},
        geometry: {
          type: "Polygon",
          coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
        }
      });
    }
    map.addSource(sourceId, {type: "geojson", data: {type: "FeatureCollection", features}});
    map.addLayer({id: layerIds[0], type: "fill", source: sourceId, filter: ["==", ["geometry-type"], "Polygon"], paint: {"fill-color": "#f59e0b", "fill-opacity": 0.24}});
    map.addLayer({id: layerIds[1], type: "line", source: sourceId, filter: ["!=", ["geometry-type"], "Point"], paint: {"line-color": "#f59e0b", "line-width": 3, "line-dasharray": [2, 1]}});
    map.addLayer({id: layerIds[2], type: "circle", source: sourceId, filter: ["==", ["geometry-type"], "Point"], paint: {"circle-color": "#fff7ed", "circle-radius": 6, "circle-stroke-color": "#d97706", "circle-stroke-width": 3}});
  }

  function authoringCoordinateTemplate(context, kind) {
    if (context.state.authoringCoordinateDraft?.kind === kind) {
      return context.state.authoringCoordinateDraft.value;
    }
    const center = context.state.map?.getCenter?.();
    const longitude = boundedCoordinate(center?.lng, 13.405);
    const latitude = boundedCoordinate(center?.lat, 52.52);
    const zoom = context.state.map?.getZoom?.() ?? 10;
    const delta = Math.max(0.0001, Math.min(2, 18 / (2 ** Math.max(0, zoom))));
    const west = boundedCoordinate(longitude - delta, longitude);
    const east = boundedCoordinate(longitude + delta, longitude);
    const south = boundedCoordinate(latitude - delta, latitude);
    const north = boundedCoordinate(latitude + delta, latitude);
    if (kind === "LineString") return `${west},${latitude} ${east},${latitude}`;
    if (kind === "Polygon") {
      return `${west},${south} ${east},${south} ${east},${north} ${west},${north} ${west},${south}`;
    }
    return `${longitude},${latitude}`;
  }

  function authoringMapExtent(context) {
    const bounds = context.state.map?.getBounds?.();
    if (bounds) return normalizeWgs84CaptureExtent([
      bounds.getWest?.(),
      bounds.getSouth?.(),
      bounds.getEast?.(),
      bounds.getNorth?.()
    ]);
    return [...DEFAULT_AUTHORING_EXTENT];
  }

  function mapAuthoringGuide(context) {
    const {state} = context;
    const draft = state.mapAuthoring;
    const guide = document.createElement("section");
    guide.className = "gis-map-authoring-guide";
    guide.dataset.authoringKind = draft.kind;
    guide.role = "status";
    guide.ariaLive = "polite";
    const label = draft.kind === "LineString" ? "Draw path" : draft.kind === "image-overlay" ? "Place image overlay" : `Draw ${draft.kind.toLowerCase()}`;
    guide.append(
      textElement("strong", label),
      textElement("span", mapAuthoringInstruction(draft))
    );
    const actions = document.createElement("div");
    actions.className = "gis-map-authoring-actions";
    const undo = actionButton("Undo vertex", () => undoMapAuthoringPoint(context));
    undo.disabled = !draft.coordinates.length;
    if (draft.kind !== "Point") {
      const finishLabel = draft.kind === "LineString"
        ? "Finish path"
        : draft.kind === "Polygon"
          ? "Finish polygon"
          : "Use extent";
      const finish = actionButton(finishLabel, () => finishMapAuthoring(context));
      finish.disabled = !mapAuthoringCanFinish(draft);
      actions.append(finish, undo);
    }
    actions.append(actionButton("Cancel drawing", () => cancelMapAuthoring(context)));
    guide.append(actions);
    return guide;
  }

  function queryDrawingGuide(context) {
    const drawing = context.state.queryDrawing;
    const guide = document.createElement("section");
    guide.className = "gis-map-authoring-guide gis-query-drawing-guide";
    guide.dataset.queryGeometry = drawing.kind;
    guide.role = "status";
    guide.ariaLive = "polite";
    const drawingLabel = ({
      LineString: "query line",
      MultiPoint: "multiple-point query",
      Box: "box query"
    })[drawing.kind] ?? `${drawing.kind.toLowerCase()} query`;
    guide.append(
      textElement("strong", `Draw ${drawingLabel}`),
      textElement("span", queryDrawingInstruction(drawing))
    );
    const actions = document.createElement("div");
    actions.className = "gis-map-authoring-actions";
    const finish = actionButton("Finish selection", () => finishQueryDrawing(context));
    finish.disabled = !queryDrawingCanFinish(drawing);
    const undo = actionButton("Undo vertex", () => undoQueryDrawingPoint(context));
    undo.disabled = !drawing.coordinates.length;
    if (drawing.kind !== "Point") actions.append(finish, undo);
    actions.append(actionButton("Cancel", () => cancelQueryDrawing(context)));
    guide.append(actions);
    return guide;
  }

  return {
    beginMapAuthoring,
    polygonOriginHit,
    addMapAuthoringPoint,
    cancelMapAuthoring,
    mapAuthoringInstruction,
    syncMapAuthoringLayer,
    beginQueryDrawing,
    addQueryDrawingPoint,
    useVisibleQueryArea,
    cancelQueryDrawing,
    syncQueryGeometryLayer,
    authoringCoordinateTemplate,
    authoringMapExtent,
    mapAuthoringGuide,
    queryDrawingGuide
  };
}
