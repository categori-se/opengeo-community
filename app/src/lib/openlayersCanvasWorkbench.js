import {
  OPENLAYERS_CANVAS_CAPABILITIES, OPENLAYERS_CANVAS_VERSION,
  canvasLayerData, canvasGeometryData, canvasFeatureMatches, canvasFeaturePaint, canvasCaptureIssue,
  openlayersCanvasCompatibility, validateCanvasCaptureSize, validateCanvasCaptureDataUrl,
  canvasSourceRights, canvasCaptureCanvases, OPENLAYERS_CANVAS_CAPTURE_LIMITS
} from './openlayersCanvasContent.js';
import {createPathMeasurement, PATH_MEASUREMENT_LIMITS} from './pathMeasurement.js';
import {createPolygonMeasurement, AREA_MEASUREMENT_LIMITS} from './areaMeasurement.js';
import {createOpenLayersCanvasControls} from './openlayersCanvasControls.js';

export {openlayersCanvasCompatibility, OPENLAYERS_CANVAS_CAPABILITIES};

// Keep all native Canvas SDK imports behind deliberate renderer activation.
async function loadCanvasModules() {
  return import('../assets/openlayers-canvas-runtime.js');
}

function normalizedView(value = {}) {
  const raw = value.center?.toArray?.() ?? value.center;
  const center = Array.isArray(raw) ? raw : raw && [raw.lng, raw.lat];
  return {center: center?.length === 2 && center.every(Number.isFinite) ? [center[0], Math.max(-85.05112878, Math.min(85.05112878, center[1]))] : [0, 0],
    zoom: Number.isFinite(value.zoom) ? Math.max(-1, Math.min(23, value.zoom)) : 2,
    bearing: Number.isFinite(value.bearing) ? value.bearing : 0, pitch: 0};
}

function textAttribution(value, document) {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(Boolean).map(entry => {
    const element = document.createElement('div');
    // Parse provider credit as inert text, never insert provider HTML in the map.
    element.innerHTML = String(entry);
    return element.textContent.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

/** A separate Canvas map, deliberately not a simulated MapLibre API. */
export async function createOpenLayersCanvasWorkbench({
  container, layers = [], dataByLayerId = new Map(), view = {}, basemap = null,
  onViewChange = () => {}, onIdentify = () => {}, onDraw = () => {}, onError = () => {}
} = {}) {
  if (!container?.ownerDocument) throw new Error('A map container is required for 2D compatibility mode.');
  const sdk = await loadCanvasModules(), document = container.ownerDocument;
  let closed = false, drawing = null, interactionMode = 'navigate', currentLayers = layers,
    currentData = dataByLayerId, currentBasemap = basemap, report, nativeLayers = [],
    tileLayer = null, tileFailure = false, tilePending = 0, basemapSourceKey = null, revision = 0;
  const eventKeys = [], tileEventKeys = [], pendingCaptures = new Set(), loadingTiles = new Set(), retainedFeatures = new WeakMap();
  const host = document.createElement('div');
  host.className = 'opengeo-canvas-map';
  host.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#f1f5f9;';
  host.tabIndex = 0;
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', '2D compatibility map. Use arrow keys to pan and plus or minus to zoom.');
  container.append(host);
  const initial = normalizedView(view), nativeView = new sdk.View({center: sdk.fromLonLat(initial.center),
    zoom: initial.zoom + 1, minZoom: 0, maxZoom: 24, rotation: -initial.bearing * Math.PI / 180,
    constrainResolution: false, multiWorld: false});
  let map;
  try {
    map = new sdk.Map({target: host, view: nativeView, controls: [], keyboardEventTarget: host,
      interactions: sdk.defaults({altShiftDragRotate: false, pinchRotate: false}),
      maxTilesLoading: 8, moveTolerance: 3});
  } catch (error) { host.remove(); throw error; }
  let controls;
  try { controls = await createOpenLayersCanvasControls({map, host, sdk}); }
  catch (error) {map.setTarget(undefined); map.dispose(); host.remove(); throw error;}
  const drawSource = new sdk.VectorSource({wrapX: false});
  const drawLayer = new sdk.VectorLayer({source: drawSource, zIndex: 1000000,
    style: new sdk.Style({fill: new sdk.Fill({color: 'rgba(37,99,235,.15)'}),
      stroke: new sdk.Stroke({color: '#2563eb', width: 2}),
      image: new sdk.Circle({radius: 6, fill: new sdk.Fill({color: '#2563eb'}), stroke: new sdk.Stroke({color: '#fff', width: 1})})})});
  map.addLayer(drawLayer);
  const format = new sdk.GeoJSON();
  const notifyError = error => { if (!closed) onError(error instanceof Error ? error : new Error(String(error))); };
  function ensureOpen() { if (closed) throw new Error('The 2D compatibility map has been closed.'); }
  function getView() {
    const center = sdk.toLonLat(nativeView.getCenter());
    return {center: [center[0], center[1]], zoom: nativeView.getZoom() - 1,
      bearing: -nativeView.getRotation() * 180 / Math.PI, pitch: 0};
  }
  function setView(next) {
    ensureOpen();
    const target = normalizedView({...getView(), ...next});
    nativeView.cancelAnimations();
    nativeView.setCenter(sdk.fromLonLat(target.center));
    nativeView.setZoom(target.zoom + 1);
    nativeView.setRotation(-target.bearing * Math.PI / 180);
    map.render();
    return getView();
  }
  function credits() {
    const values = currentLayers.filter(layer => layer.visible !== false).flatMap(layer => textAttribution(layer.attribution, document));
    if (currentBasemap && report.basemap.status !== 'unavailable' && (currentBasemap.opacity ?? 1) > 0) values.unshift(...textAttribution(currentBasemap.attribution, document));
    return [...new Set(values)];
  }
  function refreshAttribution() { controls.setAttribution(credits()); }
  function alpha(color, opacity) { const result = sdk.asArray(color).slice(); result[3] = (result[3] ?? 1) * opacity; return result; }
  function featureStyle(layer, hasStatus) {
    return feature => {
      const original = retainedFeatures.get(feature)?.feature;
      if (!original || !canvasFeatureMatches(layer.filter, original)) return undefined;
      const paint = canvasFeaturePaint(layer, original, hasStatus), geometry = feature.getGeometry()?.getType();
      if (!geometry) return undefined;
      const point = geometry.includes('Point'), polygon = geometry.includes('Polygon');
      const style = new sdk.Style({
        fill: polygon && !paint.outlineOnly ? new sdk.Fill({color: alpha(paint.fill, paint.fillOpacity)}) : undefined,
        stroke: !point ? new sdk.Stroke({color: alpha(polygon ? (paint.outlineOnly ? paint.fill : paint.stroke) : paint.line, paint.opacity),
          width: polygon ? paint.strokeWidth : paint.lineWidth}) : undefined,
        image: point ? new sdk.Circle({radius: paint.radius, fill: new sdk.Fill({color: alpha(paint.pointColor, paint.opacity)}),
          stroke: new sdk.Stroke({color: alpha('#ffffff', paint.opacity), width: 1.25})}) : undefined
      });
      if (layer.labels?.enabled) {
        const labels = layer.labels, value = original.properties?.[labels.field];
        if (value !== null && value !== undefined) {
          const label = `${labels.prefix ?? ''}${String(value)}${labels.suffix ?? ''}`.slice(0, 256);
          style.setText(new sdk.Text({text: label, font: `${labels.size ?? 12}px sans-serif`,
            textAlign: 'center', textBaseline: 'top', offsetY: (labels.size ?? 12) * 1.1,
            overflow: true, declutterMode: labels.allowOverlap === true ? 'none' : 'declutter',
            fill: new sdk.Fill({color: alpha(labels.color ?? '#111827', paint.opacity)}),
            stroke: new sdk.Stroke({color: alpha(labels.haloColor ?? '#ffffff', paint.opacity), width: (labels.haloWidth ?? 1.2) * 2})}));
        }
      }
      return style;
    };
  }
  function clearNativeLayers({basemap = true} = {}) {
    controls.updateLayers();
    for (const layer of nativeLayers) {
      map.removeLayer(layer);
      layer.getSource()?.clear?.();
      layer.getSource()?.dispose();
      layer.dispose();
    }
    nativeLayers = [];
    if (basemap) {
      sdk.unByKey(tileEventKeys.splice(0));
      for (const tile of loadingTiles) tile.getImage().src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      loadingTiles.clear();
      if (tileLayer) { map.removeLayer(tileLayer); tileLayer.getSource()?.dispose(); tileLayer.dispose(); tileLayer = null; }
      tilePending = 0; tileFailure = false; basemapSourceKey = null;
    }
  }
  function setLayers(nextLayers = currentLayers, nextData = currentData, options = {}) {
    ensureOpen();
    currentLayers = nextLayers; currentData = nextData; revision++;
    if (Object.hasOwn(options, 'basemap')) currentBasemap = options.basemap;
    report = openlayersCanvasCompatibility({layers: currentLayers, dataByLayerId: currentData, basemap: currentBasemap});
    const sourceKey = currentBasemap && report.basemap.status !== 'unavailable' ? JSON.stringify({
      url: currentBasemap.url ?? currentBasemap.tiles[0], tileSize: currentBasemap.tileSize ?? 256,
      minZoom: currentBasemap.minZoom ?? 0, maxZoom: currentBasemap.maxZoom ?? 19
    }) : null;
    clearNativeLayers({basemap: sourceKey !== basemapSourceKey});
    if (sourceKey && !tileLayer) {
      const source = new sdk.XYZ({url: currentBasemap.url ?? currentBasemap.tiles[0], crossOrigin: 'anonymous',
        attributions: currentBasemap.attribution, tileSize: currentBasemap.tileSize ?? 256,
        minZoom: currentBasemap.minZoom ?? 0, maxZoom: currentBasemap.maxZoom ?? 19,
        wrapX: true, transition: 0});
      tileEventKeys.push(source.on('tileloadstart', event => {loadingTiles.add(event.tile); tilePending = loadingTiles.size;}),
        source.on('tileloadend', event => {loadingTiles.delete(event.tile); tilePending = loadingTiles.size;}),
        source.on('tileloaderror', event => {loadingTiles.delete(event.tile); tilePending = loadingTiles.size; tileFailure = true; notifyError(new Error('The raster background could not be loaded. Check the provider and its cross-origin permissions.'));}));
      tileLayer = new sdk.TileLayer({source, opacity: currentBasemap.opacity ?? 1, zIndex: -1,
        preload: 0, useInterimTilesOnError: false});
      map.addLayer(tileLayer); basemapSourceKey = sourceKey;
    }
    if (tileLayer) tileLayer.setOpacity(currentBasemap.opacity ?? 1);
    // Workbench lists topmost Layers first. OL draws larger z-index last.
    currentLayers.forEach((layer, index) => {
      const entry = report.entries[index];
      if (entry.status === 'unavailable') return;
      const geojson = canvasLayerData(currentData, layer.layerId);
      try {
        // Validate paint before installing a deferred style callback.
        for (const color of [layer.style?.fill, layer.style?.stroke, layer.style?.circleColor,
          layer.labels?.color, layer.labels?.haloColor].filter(value => value !== undefined)) sdk.asArray(color);
        const features = format.readFeatures(canvasGeometryData(geojson), {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
        features.forEach((feature, featureIndex) => retainedFeatures.set(feature, {layerId: layer.layerId, featureIndex, feature: geojson.features[featureIndex]}));
        const hasStatus = geojson.features.some(feature => Object.hasOwn(feature.properties ?? {}, 'status'));
        const native = new sdk.VectorLayer({source: new sdk.VectorSource({features, wrapX: false}),
          style: featureStyle(layer, hasStatus), visible: layer.visible !== false,
          opacity: layer.opacityMode === 'composite' ? layer.opacity ?? 1 : 1,
          declutter: true, zIndex: currentLayers.length - index});
        native.set('opengeoLayerId', layer.layerId);
        nativeLayers.push(native); map.addLayer(native);
      } catch (error) {
        entry.status = 'unavailable';
        const issue = {code: 'canvas-source', message: 'This loaded Layer could not be prepared for Canvas rendering.'};
        entry.issues.push(issue); report.unsupportedLayers.push(entry); report.issues.push({...issue, layerId: layer.layerId});
        report.fullySupported = false; notifyError(new Error(issue.message));
      }
    });
    report.canCapture = !canvasCaptureIssue(report, currentBasemap);
    controls.updateLayers(nativeLayers); refreshAttribution(); map.render();
    return report;
  }
  function identify(pixel) {
    ensureOpen();
    const value = Array.isArray(pixel) ? pixel : [pixel?.x, pixel?.y];
    if (!value.every(Number.isFinite)) return {features: [], coordinate: null};
    const features = [], seen = new Set();
    map.forEachFeatureAtPixel(value, feature => {
      const original = retainedFeatures.get(feature);
      if (original && !seen.has(`${original.layerId}:${original.featureIndex}`)) {
        seen.add(`${original.layerId}:${original.featureIndex}`); features.push({...original});
      }
    }, {hitTolerance: 5, layerFilter: layer => nativeLayers.includes(layer)});
    const position = map.getCoordinateFromPixel(value);
    return {features, coordinate: position ? sdk.toLonLat(position) : null};
  }
  function fitGeoJSON(geojson, {padding = 48, maxZoom = 16} = {}) {
    ensureOpen();
    if (openlayersCanvasCompatibility({layers: [{layerId: 'canvas-fit'}], dataByLayerId: {'canvas-fit': geojson}}).unsupportedLayers.length) return false;
    const features = format.readFeatures(canvasGeometryData(geojson), {dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});
    const extent = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) {
      const bounds = feature.getGeometry()?.getExtent();
      if (bounds) {extent[0] = Math.min(extent[0], bounds[0]); extent[1] = Math.min(extent[1], bounds[1]); extent[2] = Math.max(extent[2], bounds[2]); extent[3] = Math.max(extent[3], bounds[3]);}
    }
    if (!extent.every(Number.isFinite)) return false;
    nativeView.fit(extent, {padding: Array.isArray(padding) ? padding : [padding, padding, padding, padding], maxZoom: maxZoom + 1, duration: 0});
    return true;
  }
  function cancelInteraction() {
    if (drawing) { drawing.abortDrawing(); map.removeInteraction(drawing); drawing.dispose(); drawing = null; }
    drawSource.clear(); interactionMode = 'navigate'; host.style.cursor = '';
  }
  function finishInteraction() {ensureOpen(); return drawing?.finishDrawing() ?? null;}
  function setInteraction(mode = 'navigate') {
    ensureOpen(); cancelInteraction();
    const aliases = {point: 'Point', line: 'LineString', path: 'LineString', polygon: 'Polygon',
      'draw-point': 'Point', 'draw-line': 'LineString', 'draw-polygon': 'Polygon',
      distance: 'measure-distance', area: 'measure-area'};
    mode = aliases[mode] ?? mode;
    if (['navigate', 'identify'].includes(mode)) {interactionMode = mode; return mode;}
    const type = mode === 'measure-distance' ? 'LineString' : mode === 'measure-area' ? 'Polygon' : mode;
    if (!['Point', 'LineString', 'Polygon'].includes(type)) throw new Error('This drawing tool is unavailable in 2D compatibility mode.');
    interactionMode = mode; host.style.cursor = 'crosshair';
    drawing = new sdk.Draw({source: drawSource, type, stopClick: true,
      maxPoints: type === 'Polygon' ? AREA_MEASUREMENT_LIMITS.maximumVertices : PATH_MEASUREMENT_LIMITS.maximumVertices});
    drawing.on('drawstart', () => drawSource.clear());
    drawing.on('drawend', event => {
      const completedMode = interactionMode, completedDrawing = drawing;
      try {
        const feature = format.writeFeatureObject(event.feature, {featureProjection: 'EPSG:3857', dataProjection: 'EPSG:4326', decimals: 10});
        const drawingReport = openlayersCanvasCompatibility({layers: [{layerId: 'canvas-draft'}],
          dataByLayerId: {'canvas-draft': {type: 'FeatureCollection', features: [feature]}}});
        if (drawingReport.unsupportedLayers.length) throw new Error('Finish a valid point, line or closed polygon before saving the drawing.');
        // Reuse the existing analytical models; Canvas never calculates a second result.
        const id = `canvas-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        const measurement = completedMode === 'measure-distance' ? createPathMeasurement({id, coordinates: feature.geometry.coordinates})
          : completedMode === 'measure-area' ? createPolygonMeasurement({id, coordinates: feature.geometry.coordinates[0]}) : null;
        onDraw({mode: completedMode, feature, geojson: {type: 'FeatureCollection', features: [feature]}, measurement});
      } catch (error) {notifyError(error);}
      // Draw inserts its completed sketch after this event; cancel in a microtask.
      queueMicrotask(() => {
        // OL inserts this sketch after drawend. Remove only the completed
        // feature if its callback already selected another interaction.
        if (closed) return;
        drawSource.removeFeature(event.feature);
        if (drawing === completedDrawing) cancelInteraction();
      });
    });
    map.addInteraction(drawing); host.focus({preventScroll: true});
    return mode;
  }
  function waitForRender(signal, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let timer, key;
      const finish = error => {clearTimeout(timer); if (key) sdk.unByKey(key); signal?.removeEventListener('abort', abort); pendingCaptures.delete(cancel); error ? reject(error) : resolve();};
      const abort = () => finish(new DOMException('Map capture canceled.', 'AbortError'));
      const cancel = () => finish(new Error('The map closed before capture completed.'));
      if (signal?.aborted) {abort(); return;}
      pendingCaptures.add(cancel); signal?.addEventListener('abort', abort, {once: true});
      timer = setTimeout(() => finish(new Error('The map is still loading. Wait for the background before exporting.')), timeoutMs);
      key = map.once('rendercomplete', () => finish()); map.renderSync();
    });
  }
  async function capture({signal, onPhase = () => {}} = {}) {
    ensureOpen();
    const issue = canvasCaptureIssue(report, currentBasemap);
    if (issue) throw new Error(issue);
    if (drawing) throw new Error('Finish or cancel the current drawing before capturing the map.');
    if (tileFailure) throw new Error('The raster background failed to load. A complete map image cannot be exported.');
    validateCanvasCaptureSize(...(map.getSize() ?? []));
    const captureRevision = revision;
    onPhase('rendering'); await waitForRender(signal); ensureOpen();
    if (captureRevision !== revision) throw new Error('The displayed Layers changed during capture. Create the image again.');
    if (tileFailure || tilePending) throw new Error('The raster background is incomplete. A complete map image cannot be exported.');
    const [width, height] = map.getSize() ?? [];
    validateCanvasCaptureSize(width, height);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas image capture is unavailable in this browser.');
    context.fillStyle = '#f1f5f9'; context.fillRect(0, 0, width, height);
    let painted = 0;
    for (const source of canvasCaptureCanvases(map.getViewport())) {
      if (!source.width || !source.height) continue;
      const opacity = source.parentNode?.style.opacity ?? source.style.opacity;
      context.globalAlpha = opacity === '' || opacity === undefined ? 1 : Number(opacity);
      const transform = source.style.transform;
      const matrix = transform?.match(/^matrix\(([^)]+)\)$/)?.[1].split(',').map(Number);
      if (matrix?.length === 6 && matrix.every(Number.isFinite)) context.setTransform(...matrix);
      else context.setTransform(source.clientWidth ? source.clientWidth / source.width : 1, 0, 0, source.clientHeight ? source.clientHeight / source.height : 1, 0, 0);
      context.drawImage(source, 0, 0); painted++;
    }
    context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = 1;
    const attributionLines = credits();
    if (attributionLines.length) {
      context.font = '11px sans-serif';
      const lines = [], maximumWidth = Math.max(40, width - 12);
      for (const credit of attributionLines) {
        let line = '';
        for (const word of credit.split(/\s+/)) {
          const next = line ? `${line} ${word}` : word;
          if (line && context.measureText(next).width > maximumWidth) {lines.push(line); line = word;} else line = next;
        }
        if (line) lines.push(line);
      }
      if (lines.length * 14 + 8 > height) throw new Error('The viewport is too small to retain all source attribution in this image. Enlarge the map before exporting.');
      const top = Math.max(0, height - lines.length * 14 - 8);
      context.fillStyle = 'rgba(255,255,255,.94)'; context.fillRect(0, top, width, height - top);
      context.fillStyle = '#172033'; lines.forEach((line, index) => context.fillText(line, 6, top + 14 + index * 14));
    }
    if (!painted && (nativeLayers.some(layer => layer.getVisible() && layer.getSource().getFeatures().some(feature => feature.getGeometry())) || tileLayer)) throw new Error('The map has not produced a rendered image.');
    let dataUrl;
    try {dataUrl = canvas.toDataURL('image/png');}
    catch {throw new Error('This background does not permit Canvas image export. Check its cross-origin permissions or choose an exportable background.');}
    validateCanvasCaptureDataUrl(dataUrl);
    return {dataUrl, width, height, cssWidth: width, cssHeight: height, view: getView(),
      projection: 'mercator', flat: true,
      metresPerPixel: sdk.getPointResolution(nativeView.getProjection(), nativeView.getResolution(), nativeView.getCenter(), 'm'),
      metadata: {renderer: 'openlayers-canvas', rendererVersion: OPENLAYERS_CANVAS_VERSION, mode: 'canvas',
        attribution: attributionLines, layers: structuredClone(report.entries),
        captureLimits: OPENLAYERS_CANVAS_CAPTURE_LIMITS,
        sourceRights: currentLayers.filter(layer => layer.visible !== false).map(layer => ({layerId: layer.layerId, ...canvasSourceRights(layer)})),
        basemapRights: currentBasemap ? {id: currentBasemap.id ?? null, ...canvasSourceRights(currentBasemap)} : null,
        differences: report.issues.filter(issue => issue.different),
        licenses: currentLayers.filter(layer => layer.visible !== false && layer.license).map(layer => ({layerId: layer.layerId, license: canvasSourceRights(layer).license}))}};
  }
  eventKeys.push(map.on('moveend', () => { if (!closed) onViewChange(getView()); }),
    map.on('singleclick', event => { if (!closed && !drawing) onIdentify(identify(event.pixel)); }));
  const keydown = event => {
    if (event.key === 'Escape' && drawing) {event.preventDefault(); cancelInteraction();}
    else if (event.key === 'Enter' && drawing) {event.preventDefault(); drawing.finishDrawing();}
  };
  host.addEventListener('keydown', keydown);
  function dispose() {
    if (closed) return;
    cancelInteraction(); closed = true;
    for (const cancel of [...pendingCaptures]) cancel();
    sdk.unByKey(eventKeys); clearNativeLayers();
    controls.dispose();
    host.removeEventListener('keydown', keydown);
    drawSource.clear(); drawSource.dispose(); drawLayer.dispose();
    map.setTarget(undefined); map.dispose(); host.remove();
  }
  try {setLayers(layers, dataByLayerId); map.updateSize(); map.renderSync();}
  catch (error) {dispose(); throw error;}
  return {renderer: 'openlayers-canvas', capabilities: OPENLAYERS_CANVAS_CAPABILITIES,
    get unsupportedLayers() {return report.unsupportedLayers;},
    getCompatibilityReport: () => structuredClone({...report, canCapture: report.canCapture && !drawing && !tileFailure}), setLayers, getView, setView,
    fitGeoJSON, identify, setInteraction, finishInteraction, cancelInteraction, capture,
    resize() {if (!closed) {map.updateSize(); map.render();}}, dispose};
}
