import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {parseKml} from '../src/lib/kmlPlaces.js';
import {refreshKmlRegionPresentation} from '../src/components/WorkbenchView.js';

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
