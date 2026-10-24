import assert from "node:assert/strict";
import {test} from "node:test";
import {jsPDF} from "jspdf";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";
import {printCaptureOutputSignature} from "../src/lib/printLayouts.js";
import {assertPrintGeoReference, printMapPlacement, printGeoPdfRegistrations, registerPrintPdfMaps} from "../src/lib/printGeoPdf.js";

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const inverse = ([x, y]) => [x / 6378137 * 180 / Math.PI, Math.atan(Math.sinh(y / 6378137)) * 180 / Math.PI];
function fixture({bearing = 0} = {}) {
  const cssWidth = 720, cssHeight = 440, angle = bearing * Math.PI / 180;
  const controls = [[0, 0], [cssWidth, 0], [cssWidth, cssHeight], [0, cssHeight]].map(css => {
    const dx = (css[0] - cssWidth / 2) * 4200, dy = -(css[1] - cssHeight / 2) * 4200;
    return {css, lngLat: inverse([1000000 + dx * Math.cos(angle) - dy * Math.sin(angle),
      4000000 + dx * Math.sin(angle) + dy * Math.cos(angle)])};
  });
  const view = {center: inverse([1000000, 4000000]), zoom: 4, pitch: 0, bearing};
  const georeference = {crs: "EPSG:3857", geographicCrs: "EPSG:4326", controls};
  const frames = [{id: "main", title: "Main map", xMm: 10, yMm: 27, widthMm: 215, heightMm: 153, view, presentation: []},
    {id: "inset", title: "Inset", xMm: 235, yMm: 130, widthMm: 50, heightMm: 36, view, presentation: []}];
  const layout = {id: "layout", dpi: 96, page: {widthMm: 297, heightMm: 210}, frames};
  const signature = canonicalJson({view, presentation: []});
  const captures = new Map(frames.map((frame, index) => [`layout:${frame.id}`, {
    width: index ? 189 : 813, height: index ? 115 : 496, cssWidth, cssHeight, view, signature,
    outputSignature: printCaptureOutputSignature(frame, layout.dpi),
    vectorScene: {cssWidth, cssHeight, view, signature, georeference: structuredClone(georeference)}
  }]));
  return {layout, captures, georeference};
}

test("geographic placement follows actual captured-pixel letterboxing for main and inset", () => {
  const {layout, captures} = fixture(), main = printMapPlacement(layout.frames[0], captures.get("layout:main"));
  close(main.x, 10);close(main.y, 37.915744157441566);close(main.width, 215);close(main.height, 131.16851168511687);
  const inset = printMapPlacement(layout.frames[1], captures.get("layout:inset"));
  close(inset.x, 235);close(inset.y, 132.7883597883598);close(inset.height, 30.42328042328042);
  assert.throws(() => printMapPlacement(layout.frames[0], {width: 0, height: 496}), /dimensions/);
});

test("real geographic controls accept rotated Mercator affinity and refuse altered, reversed or unsupported controls", () => {
  const {georeference} = fixture({bearing: 37}), before = JSON.stringify(georeference);
  assert.equal(assertPrintGeoReference(georeference, 720, 440), georeference);
  assert.equal(JSON.stringify(georeference), before);
  for (const change of [
    value => {value.controls[2].lngLat[0] += 0.001;},
    value => {value.controls[0].css = [1, 0];},
    value => {value.controls.reverse();},
    value => {value.controls[1].lngLat = [...value.controls[0].lngLat];},
    value => {value.controls[1].lngLat[0] = Infinity;},
    value => {value.controls[0].lngLat[1] = 86;},
    value => {value.controls[0].lngLat[0] = -179;value.controls[1].lngLat[0] = 179;},
    value => {value.crs = "EPSG:4326";},
    value => {value.extra = "untrusted";}
  ]) {
    const value = structuredClone(georeference);change(value);
    assert.throws(() => assertPrintGeoReference(value, 720, 440), /GeoPDF/);
  }
});

test("registrations retain actual controls and GDAL UL/LL/LR/UR latitude-longitude order without mutating captures", () => {
  const {layout, captures} = fixture({bearing: -23}), before = JSON.stringify({layout, captures: [...captures]});
  const maps = printGeoPdfRegistrations(layout, captures, "layout"), controls = captures.get("layout:main").vectorScene.georeference.controls;
  assert.equal(maps.length, 2);assert.deepEqual(maps.map(map => map.name), ["main", "inset"]);
  assert.deepEqual(maps[0].lpts, [0, 1, 0, 0, 1, 0, 1, 1]);
  assert.deepEqual(maps[0].gpts, [0, 3, 2, 1].flatMap(index => [controls[index].lngLat[1], controls[index].lngLat[0]]));
  [28.34645669291335, 115.98163698172414, 637.7952755905512, 487.79789057733103].forEach((value, index) => close(maps[0].bbox[index], value));
  [666.1417322834646, 132.62842144731908, 807.8740157480315, 218.8676415448069].forEach((value, index) => close(maps[1].bbox[index], value));
  assert.equal(JSON.stringify({layout, captures: [...captures]}), before);
});

test("GeoPDF refuses legacy missing controls and stale views, sizing or off-paper regions", () => {
  for (const change of [
    value => {delete value.captures.get("layout:main").vectorScene.georeference;},
    value => {value.layout.frames[0] = {...value.layout.frames[0], view: {...value.layout.frames[0].view, zoom: 5}};},
    value => {value.layout.frames[0].widthMm = 210;},
    value => {value.layout.frames[0].xMm = 100;},
    value => {value.captures.get("layout:main").vectorScene.cssWidth = 721;}
  ]) {
    const value = fixture();change(value);
    assert.throws(() => printGeoPdfRegistrations(value.layout, value.captures, "layout"), /GeoPDF/);
  }
  assert.throws(() => printGeoPdfRegistrations(fixture().layout, new Map(), "other-layout"), /single-page/);
});

function objects(output) {
  return new Map([...output.matchAll(/^(\d+) 0 obj\n([\s\S]*?)\nendobj/gm)].map(match => [Number(match[1]), match[2]]));
}
function assertCrossReferences(output) {
  const xref = /\nxref\n0 (\d+)\n([\s\S]*?)\ntrailer/.exec(output);
  assert.ok(xref, "xref exists");
  const lines = xref[2].trim().split("\n");assert.equal(lines.length, Number(xref[1]));
  for (let index = 1; index < lines.length; index++) {
    const offset = Number(lines[index].slice(0, 10));
    assert.ok(output.slice(offset).startsWith(`${index} 0 obj`), `object ${index} xref resolves`);
  }
}

test("actual jsPDF serialization adds two resolved viewports while retaining paths and stable repeated output", () => {
  const {layout, captures} = fixture(), maps = printGeoPdfRegistrations(layout, captures, "layout");
  const pdf = new jsPDF({unit: "mm", format: [297, 210], orientation: "landscape", compress: false, putOnlyUsedFonts: true});
  pdf.moveTo(20, 30);pdf.lineTo(100, 80);pdf.lineTo(30, 110);pdf.close();pdf.stroke();
  const painted = [...pdf.internal.pages[1]];
  registerPrintPdfMaps(pdf, maps);
  // Later caller mutations cannot change the subscribed serialization.
  maps[0].gpts[0] = -80;
  for (const output of [pdf.output(), pdf.output()]) {
    assert.match(output, /^%PDF-1\.7/);assert.doesNotMatch(output, /\/Subtype \/Image/);
    assert.deepEqual(pdf.internal.pages[1], painted);
    const entries = objects(output), page = [...entries.values()].find(body => body.startsWith("<</Type /Page\n"));
    const refs = [...page.match(/\/VP \[([^\]]+)\]/)[1].matchAll(/(\d+) 0 R/g)].map(match => Number(match[1]));
    assert.equal(refs.length, 2);assert.equal([...entries.values()].filter(body => body.includes("/Type /Viewport")).length, 2);
    for (const [index, ref] of refs.entries()) {
      const viewport = entries.get(ref);assert.match(viewport, new RegExp(`/Name \\(${index ? "inset" : "main"}\\)`));
      const measure = entries.get(Number(/\/Measure (\d+) 0 R/.exec(viewport)[1]));
      assert.match(measure, /\/Type \/Measure \/Subtype \/GEO/);
      assert.match(measure, /\/Bounds \[0 1 0 0 1 0 1 1\]/);
      assert.match(measure, /\/LPTS \[0 1 0 0 1 0 1 1\]/);
      assert.doesNotMatch(measure, /\/GPTS \[-80 /);
      const gcs = entries.get(Number(/\/GCS (\d+) 0 R/.exec(measure)[1]));
      assert.match(gcs, /\/Type \/PROJCS \/EPSG 3857/);assert.match(gcs, /Mercator_Auxiliary_Sphere/);
    }
    assertCrossReferences(output);
  }
  assert.throws(() => registerPrintPdfMaps(pdf, printGeoPdfRegistrations(layout, captures, "layout")), /writer/);
});

test("registration encoding escapes frame names and leaves ordinary vector PDFs without geographic dictionaries", () => {
  const pdf = new jsPDF(), plainBefore = [...pdf.internal.pages[1]];
  registerPrintPdfMaps(pdf, []);assert.doesNotMatch(pdf.output(), /\/VP /);assert.deepEqual(pdf.internal.pages[1], plainBefore);
  const {layout, captures} = fixture(), maps = printGeoPdfRegistrations(layout, captures, "layout");
  maps[0].name = "main) /Untrusted (";
  maps[0].gpts[0] = 1e-10;
  const outputPdf = new jsPDF({unit: "mm", format: [297, 210], orientation: "landscape"});
  registerPrintPdfMaps(outputPdf, maps);const output = outputPdf.output();
  assert.match(output, /\/Name \(main\\\) \/Untrusted \\\(/);assert.match(output, /\/GPTS \[0\.0000000001 /);
  const bad = printGeoPdfRegistrations(layout, captures, "layout");bad[0].gpts[0] = "0 /Untrusted";
  assert.throws(() => registerPrintPdfMaps(new jsPDF(), bad), /registration/);
});
