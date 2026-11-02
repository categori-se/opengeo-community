import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {parseGxTour, exportGxTour} from "../src/lib/gxTour.js";
import {createCameraTour, addCameraTourKeyframe, cameraTourDurationMilliseconds, parseCameraTour, exportCameraTour, captureCameraTourLayerVisibility} from "../src/lib/cameraTour.js";

const dom = new JSDOM("");
const parse = text => parseGxTour(text, {Parser: dom.window.DOMParser});
const kml = playlist => `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><gx:Tour><name>Survey &amp; review</name><gx:Playlist>${playlist}</gx:Playlist></gx:Tour></Document></kml>`;
const fly = (view = "<LookAt><longitude>179</longitude><latitude>40</latitude><range>100000</range><heading>170</heading><tilt>20</tilt></LookAt>", duration = "2.5") => `<gx:FlyTo><gx:duration>${duration}</gx:duration><gx:flyToMode>smooth</gx:flyToMode>${view}</gx:FlyTo>`;
const wait = duration => `<gx:Wait><gx:duration>${duration}</gx:duration></gx:Wait>`;

describe("bounded gx:Tour camera exchange", () => {
  it("imports views and consecutive waits as an editable durable native tour with explicit camera and initial-flight loss", () => {
    const {tour, report} = parse(kml(fly() + wait(1) + wait(2) + fly(undefined, "4.25") + wait(0.5)));
    assert.equal(tour.title, "Survey & review");assert.equal(tour.keyframes.length, 2);
    assert.deepEqual(tour.keyframes[0].camera.center, [179, 40]);
    assert.equal(tour.keyframes[0].holdMilliseconds, 3000);
    assert.equal(tour.keyframes[1].transitionMilliseconds, 4250);
    assert.equal(cameraTourDurationMilliseconds(tour), 7750);
    assert.deepEqual(parseCameraTour(exportCameraTour(tour)), tour);
    assert.ok(report.entries.some(entry => entry.code === "initial_flight_omitted"));
    assert.ok(report.entries.some(entry => entry.code === "camera_reference_conversion"));
  });

  it("exports standard FlyTo/Wait XML, escapes titles and round trips supported camera values and timing", () => {
    const tour = addCameraTourKeyframe(createCameraTour({title: '<reach> & "survey"', camera: {center: [-71, 42], zoom: 8, pitch: 20, bearing: 170}}), {center: [179, 40], zoom: 12, pitch: 40, bearing: -170}, {transitionMilliseconds: 1250, holdMilliseconds: 500});
    const before = structuredClone(tour), exported = exportGxTour(tour), imported = parse(exported.kml).tour;
    assert.match(exported.kml, /&lt;reach&gt; &amp; &quot;survey&quot;/);
    assert.equal(imported.title, tour.title);
    assert.equal(cameraTourDurationMilliseconds(imported), cameraTourDurationMilliseconds(tour));
    for (let i = 0; i < tour.keyframes.length; i++) {
      assert.deepEqual(imported.keyframes[i].camera.center, tour.keyframes[i].camera.center);
      assert.ok(Math.abs(imported.keyframes[i].camera.zoom - tour.keyframes[i].camera.zoom) < 1e-10);
      assert.equal(imported.keyframes[i].camera.pitch, tour.keyframes[i].camera.pitch);
    }
    assert.equal(exported.report.hasLoss, true);assert.deepEqual(tour, before);
  });

  it("reports omitted audio, animation, controls and separate KML content without importing Layer updates", () => {
    const source = kml(fly() + '<gx:SoundCue><href>https://example.invalid/audio.mp3</href></gx:SoundCue><gx:AnimatedUpdate><gx:duration>3</gx:duration><Update/></gx:AnimatedUpdate><gx:TourControl><gx:playMode>pause</gx:playMode></gx:TourControl>');
    const result = parse(source.replace("</Document>", "<Placemark><name>separate</name></Placemark></Document>"));
    for (const name of ["SoundCue", "AnimatedUpdate", "TourControl", "Placemark"]) assert.ok(result.report.entries.some(entry => entry.path.includes(name)), name);
    assert.equal(result.tour.schemaVersion, "opengeo.camera-tour.1.0.0");
    assert.equal(Object.hasOwn(result.tour.keyframes[0], "layerVisibility"), false);
  });

  it("refuses active XML, unsafe resources, network links, malformed and ambiguous tours", () => {
    for (const text of ['<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + kml(fly()), ...['javascript:alert(1)', '../private.mp3', '/private.mp3', 'https://user:password@example.invalid/a'].map(address => kml(fly() + `<gx:SoundCue><href>${address}</href></gx:SoundCue>`)), kml(fly() + '<NetworkLink/>'), kml(fly()).replace('</gx:Tour>', '</gx:Tour><gx:Tour/>'), '<kml>broken', kml(fly()).replace('http://www.opengis.net/kml/2.2', 'urn:wrong'), '<?xml-stylesheet href="https://example.invalid/a"?>' + kml(fly())]) assert.throws(() => parse(text));
  });

  it("enforces view, timing, byte, keyframe and total-duration limits without clamping", () => {
    const precise = parse(kml(fly(undefined, '1.001') + wait('1.001') + fly(undefined, '1.001'))).tour;
    assert.equal(precise.keyframes[0].holdMilliseconds, 1001);
    assert.equal(precise.keyframes[1].transitionMilliseconds, 1001);
    assert.equal(cameraTourDurationMilliseconds(parse(exportGxTour(precise).kml).tour), 2002);
    for (const text of [kml(wait(1) + fly()), kml(fly(undefined, '-1')), kml(fly(undefined, '60.001')), kml(fly(undefined, '0.0001')), kml(fly() + wait(40) + wait(30)), kml(fly().repeat(65)), kml((fly(undefined, '60') + wait(60)).repeat(9)), 'x'.repeat(256 * 1024 + 1), kml(fly('<LookAt><latitude>89</latitude><range>1000</range></LookAt>')), kml(fly('<LookAt><range>0</range></LookAt>')), kml(fly('<LookAt><range>1e300</range></LookAt>')), kml(fly('<LookAt><range>10000</range><tilt>86</tilt></LookAt>'))]) assert.throws(() => parse(text));
  });

  it("accepts nadir Cameras and refuses unrepresentable Camera orientation or elevated targets", () => {
    assert.equal(parse(kml(fly('<Camera><longitude>10</longitude><latitude>20</latitude><altitude>100000</altitude><altitudeMode>absolute</altitudeMode></Camera>'))).tour.keyframes[0].camera.pitch, 0);
    for (const view of ['<Camera><altitude>1000</altitude><tilt>20</tilt></Camera>', '<Camera><altitude>1000</altitude><roll>1</roll></Camera>', '<LookAt><range>1000</range><altitude>20</altitude><altitudeMode>absolute</altitudeMode></LookAt>', '<LookAt><range>1000</range><altitudeMode>relativeToSeaFloor</altitudeMode></LookAt>']) assert.throws(() => parse(kml(fly(view))));
  });

  it("names exact-version Layer event and binding losses and retains native JSON", () => {
    const camera = {center: [0, 10], zoom: 5, pitch: 0, bearing: 0};
    const tour = captureCameraTourLayerVisibility(createCameraTour({camera}), 'view-1', [{layerId: 'sites', datasetId: '60000000-0000-4000-8000-000000000001', datasetVersionId: '61000000-0000-4000-8000-000000000001', sourceVersion: 1, visible: true}]);
    const exported = exportGxTour(tour);
    assert.ok(exported.report.entries.some(entry => entry.code === 'layer_events_omitted'));
    assert.ok(exported.report.entries.some(entry => entry.code === 'native_metadata_omitted'));
    assert.deepEqual(parseCameraTour(exportCameraTour(tour)), tour);
    assert.throws(() => exportGxTour({...tour, spatialBodyId: 'mars'}), /Earth/);
    for (const patch of [{roll: 10}, {elevation: 20}, {centerClampedToGround: false}]) {
      const extended = structuredClone(tour);Object.assign(extended.keyframes[0].camera, patch);
      assert.throws(() => exportGxTour(extended), error => error.code === 'gx_tour_extended_camera');
    }
    const defaults = structuredClone(tour);Object.assign(defaults.keyframes[0].camera, {roll: 0, elevation: 0, centerClampedToGround: true});
    assert.ok(exportGxTour(defaults).report.entries.some(entry => entry.code === 'extended_camera_defaults_omitted'));
  });
});
