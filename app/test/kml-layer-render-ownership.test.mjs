import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {parseKml} from '../src/lib/kmlPlaces.js';
import {WorkbenchView, addMapLayer, refreshKmlRegionPresentation} from '../src/components/WorkbenchView.js';

test('KML render handles retain their own geometry and overlay visibility with legacy fallback', () => {
  const dom = new JSDOM('');
  const document = (name, x) => parseKml(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name><Placemark><Point><coordinates>${x},42</coordinates></Point></Placemark></Document></kml>`, {DOMParser: dom.window.DOMParser}).document;
  const first = document('First', -73), second = document('Second', -71);
  const output = new Map(), container = {dataset: {}};
  const overlay = () => ({visible: true, regions: [], baseOpacity: .7, element: {hidden: false, style: {}}});
  const firstOverlay = overlay(), secondOverlay = overlay();
  const handles = new Map([
    ['first', {sourceId: 'first', kmlDocument: first, layerVisible: false, overlayPresentations: [firstOverlay]}],
    ['second', {sourceId: 'second', kmlDocument: second, overlayPresentations: [secondOverlay]}],
    ['kml-places', {sourceId: 'legacy'}],
    ['ordinary', {sourceId: 'ordinary'}]
  ]);
  const state = {kmlPlaces: first, layerHandles: handles, map: {
    getContainer: () => container,
    getSource: id => ({setData: data => output.set(id, data)})
  }};
  refreshKmlRegionPresentation(state);
  assert.equal(output.get('first').features[0].geometry.coordinates[0], -73);
  assert.equal(output.get('second').features[0].geometry.coordinates[0], -71);
  assert.deepEqual(output.get('legacy'), output.get('first'));
  assert.equal(output.has('ordinary'), false);
  assert.equal(firstOverlay.element.hidden, true);
  assert.equal(secondOverlay.element.hidden, false);
  state.kmlPlaces = second;
  refreshKmlRegionPresentation(state);
  assert.equal(output.get('first').features[0].geometry.coordinates[0], -73);
  assert.equal(output.get('legacy').features[0].geometry.coordinates[0], -71);
  assert.equal(container.dataset.kmlRegionInactive, '0');
  dom.window.close();
});


test('managed KML import keeps declared losses on its Layer through rendering, save and reopen', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {url: 'https://studio.opengeo.tools/workspaces?project=ownership'});
  const replacements = {document: dom.window.document, location: dom.window.location,
    history: dom.window.history, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, DOMParser: dom.window.DOMParser,
    localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true};
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  const source = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Loss custody</name><Placemark><Point><coordinates>12,42</coordinates></Point></Placemark><NetworkLink><name>Declared invalid link</name></NetworkLink></Document></kml>';
  const expected = parseKml(source, {DOMParser: dom.window.DOMParser}).report;
  assert.equal(expected.result, 'pass_with_declared_losses');
  assert.equal(expected.counts.omitted, 1);
  const project = {projectId: '51000000-0000-4000-8000-000000000001', title: 'Managed KML',
    mapViews: [{id: 'primary', title: 'Primary', center: [12, 42], zoom: 8}]};
  const storage = {provider: 's3', bucket: 'opengeo-test', rootPrefix: 'tenants/test/projects',
    immutableInputsPrefix: 'inputs', scratchPrefix: 'scratch', outputPrefix: 'outputs'};
  let saved, shell;
  const mount = (definition = project, layers = [], geojsonByLayerId = []) => {
    shell = WorkbenchView({workspace: {workspaceId: '50000000-0000-4000-8000-000000000001', title: 'Managed KML'},
      role: 'owner', project: definition, layers, datasets: [], geojsonByLayerId, storage, persistenceMode: 'api',
      initialPanel: 'add', restoreBrowserDraft: false,
      saveProject: async definition => {saved = structuredClone(definition); return {version: 2, definition: saved};}});
    dom.window.document.body.append(shell);
    return shell;
  };
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail('KML ownership UI did not settle');
  };
  try {
    mount();
    const input = shell.querySelector('.gis-file-drop input[type="file"]');
    assert.ok(input);
    Object.defineProperty(input, 'files', {value: [{name: 'loss-custody.kml', size: Buffer.byteLength(source), arrayBuffer: async () => new TextEncoder().encode(source).buffer}]});
    input.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    await waitFor(() => shell.dataset.kmlPlacemarks === '1');
    assert.equal(shell.dataset.kmlImport, expected.result);
    assert.equal(shell.dataset.kmlLosses, '1');
    const layer = shell.__opengeoLayers.find(layer => layer.sourceType === 'kml-places');
    assert.deepEqual(layer.kmlInterchangeReport.entries, expected.entries);
    assert.equal(layer.kmlInterchangeReport.counts.omitted, 1);
    [...shell.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save').click();
    await waitFor(() => saved);
    const savedLayer = saved.layers.find(candidate => candidate.layerId === layer.layerId);
    assert.equal(savedLayer.kmlInterchangeReport.result, expected.result);
    assert.deepEqual(savedLayer.kmlInterchangeReport.entries, expected.entries);
    shell.dispose(); shell.remove();
    const suppliedLayer = {...savedLayer, layerId: 'supplied-kml',
      kmlDocument: parseKml(source.replace('12,42', '15,45'), {DOMParser: dom.window.DOMParser}).document};
    const suppliedGeometry = {type: 'FeatureCollection', features: [{type: 'Feature', id: 'curated',
      properties: {}, geometry: {type: 'Point', coordinates: [14, 44]}}]};
    mount({...project, ...saved}, [...saved.layers, suppliedLayer], new Map([[suppliedLayer.layerId, suppliedGeometry]]));
    assert.equal(saved.kmlLayerDocuments, true);
    const restoredGeometry = shell.__opengeoData.get(savedLayer.layerId);
    assert.ok(restoredGeometry, 'managed reopen must materialize owned KML geometry for rendering');
    assert.equal(restoredGeometry.features.length, 1);
    assert.deepEqual(restoredGeometry.features[0].geometry, {type: 'Point', coordinates: [12, 42]});
    assert.equal(shell.__opengeoData.get(suppliedLayer.layerId), suppliedGeometry,
      'mount must preserve supplied geometry for another owned KML Layer');
    assert.equal(shell.dataset.kmlImport, expected.result);
    assert.equal(shell.dataset.kmlLosses, '1');
  } finally {
    shell?.dispose(); shell?.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});


test('KML screen overlays use DOM elements while retaining Layer resources and Region render handles', () => {
  const dom = new JSDOM('<!doctype html><body><div id="map"></div></body>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, writable: true, value: dom.window.document});
  const parsed = parseKml(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <ScreenOverlay id="legend"><name>Layer legend</name><Icon><href>legend.png</href></Icon></ScreenOverlay>
    <GroundOverlay id="ground"><Icon><href>legend.png</href></Icon><LatLonBox><north>43</north><south>42</south><east>13</east><west>12</west></LatLonBox></GroundOverlay>
    <PhotoOverlay id="photo"><Region><LatLonAltBox><north>43</north><south>42</south><east>13</east><west>12</west></LatLonAltBox><Lod><minLodPixels>0</minLodPixels><maxLodPixels>1</maxLodPixels></Lod></Region><Icon><href>legend.png</href></Icon><Point><coordinates>12.5,42.5</coordinates></Point></PhotoOverlay>
  </Document></kml>`, {DOMParser: dom.window.DOMParser});
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  parsed.document.resources = [{path: 'legend.png', mediaType: 'image/png', dataBase64: png}];
  const container = dom.window.document.getElementById('map'), sources = new Map(), layers = new Map();
  const map = {
    getContainer: () => container,
    getSource: id => sources.get(id),
    addSource(id, value) { sources.set(id, {...value, setData(data) {this.data = data;}}); },
    getLayer: id => layers.get(id), addLayer(value) {layers.set(value.id, value);},
    on() {}, off() {},
    project: ([x, y]) => ({x: x * 100, y: y * 100}),
    setLayoutProperty(id, key, value) {layers.get(id).layout[key] = value;},
    setPaintProperty(id, key, value) {layers.get(id).paint[key] = value;}
  };
  const state = {map, layerHandles: new Map(), kmlPlaces: {kind: 'document', children: []}};
  const layer = {layerId: 'owned-kml', sourceType: 'kml-places', visible: true, opacity: 1,
    kmlDocument: parsed.document, style: {}};
  try {
    addMapLayer(state, layer, parsed.geojson, []);
    const handle = state.layerHandles.get(layer.layerId);
    assert.ok(handle, 'overlay creation must complete before the render handle is registered');
    assert.equal(handle.kmlDocument, parsed.document);
    const image = container.querySelector('.gis-kml-screen-overlay[data-overlay-id="legend"]');
    assert.ok(image);
    assert.equal(image.ownerDocument, dom.window.document);
    assert.equal(image.src, `data:image/png;base64,${png}`);
    assert.equal(handle.overlayElements[0], image);
    assert.ok(map.getLayer('owned-kml-image-ground'));
    assert.equal(map.getSource('owned-kml-source-image-ground').url, image.src);
    assert.equal(container.dataset.kmlRegionInactive, '1');
    const photo = map.getSource('owned-kml-source').data.features.find(feature => feature.id === 'photo');
    assert.equal(photo.properties.kmlRegionActive, false);
    handle.layerVisible = false;
    refreshKmlRegionPresentation(state);
    assert.equal(image.hidden, true);
    handle.layerVisible = true;
    refreshKmlRegionPresentation(state);
    assert.equal(image.hidden, false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
    dom.window.close();
  }
});
