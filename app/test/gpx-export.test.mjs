import assert from "node:assert/strict";
import {it, after} from "node:test";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";
import {readGpxFile, originalGpxFile, GPX_IMPORT_LIMITS} from "../src/lib/gpxImport.js";
import {workingGpxFile, downloadWorkingGpx} from "../src/lib/gpxExport.js";

const dom = new JSDOM("");
const prior = new Map(["Node", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, {Node: dom.window.Node, document: dom.window.document});
after(() => {
  for (const [key, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);else delete globalThis[key];
  }
  dom.window.close();
});
const options = {Parser: dom.window.DOMParser, Serializer: dom.window.XMLSerializer};
const fixture = await readFile(new URL("../../fixtures/gps/source-survey.gpx", import.meta.url));
const file = (bytes, name = "survey.gpx") => new File([bytes], name, {type: "application/gpx+xml"});
const parse = bytes => readGpxFile(file(bytes), options);
const xmlText = bytes => new TextDecoder().decode(bytes);
const xmlDocument = bytes => new options.Parser().parseFromString(xmlText(bytes), "application/xml");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const input = async (bytes = fixture) => {
  const parsed = await parse(bytes);
  return {source: parsed.source, geojson: structuredClone(parsed.geojson)};
};
const reject = async (change, code, bytes = fixture) => {
  const value = await input(bytes);change(value);
  await assert.rejects(workingGpxFile(value, options), error => error.code === code && error.report?.operation === "reject");
};

it("exports moved waypoint/path geometry and XYZ heights while preserving XML, XY partial heights, times and gaps", async () => {
  const value = await input(), features = value.geojson.features;
  features[0].geometry.coordinates = [85.30001, 27.70002, 1451.75];
  features[1].geometry.coordinates[0] = [85.3002, 27.7003];
  features[2].geometry.coordinates[1] = [85.3301, 27.7302, 1521];
  features[0].properties.name = "Working name is deliberately outside geometry export";
  features[0].properties.untrusted = '<script src="https://never-fetch.example.test/"/>';
  const sourceBefore = JSON.stringify(value.source), workingBefore = JSON.stringify(value.geojson);
  const previousFetch = globalThis.fetch;globalThis.fetch = () => {throw Error("GPX export must remain local");};
  let result;
  try {result = await workingGpxFile(value, options);} finally {globalThis.fetch = previousFetch;}
  const reopened = await parse(result.bytes), f = reopened.geojson.features;
  assert.deepEqual(f.map(feature => feature.geometry), features.map(feature => feature.geometry));
  assert.equal(f[0].properties.name, "Survey point");
  assert.equal(f[0].properties.gpx.points[0].time, "2026-10-16T01:02:03.123400+05:45");
  assert.equal(f[4].properties.gpx.points[0].time, "2026-10-16T12:00:00");
  assert.deepEqual(f[1].properties.gpx.points.map(point => point.elevation), [null, 1500]);
  assert.deepEqual(f[3].properties.gpx.points.map(point => point.elevation), [null, 1530]);
  assert(f[0].properties.gpx.points[0].fields.some(field => field.name === "accuracy" && field.text === "4" && field.namespace === "https://example.test/gps"));
  assert(reopened.source.metadata.some(field => field.name === "context" && field.text === "Preserve this source field"));
  const document = xmlDocument(result.bytes), namespace = document.documentElement.namespaceURI;
  assert.equal(document.getElementsByTagNameNS(namespace, "trkseg").length, 4);
  assert.equal(document.getElementsByTagNameNS(namespace, "trkseg")[3].children.length, 0);
  assert.equal(document.getElementsByTagNameNS(namespace, "link")[0].getAttribute("href"), "https://never-fetch.example.test/info");
  assert.deepEqual(reopened.report.rejectedRecords, [{sourceIndex: 2, segmentIndex: 3, kind: "trk", reason: "no-positions", originalPreserved: true}]);
  assert.equal(result.report.operation, "export");assert.equal(result.report.editedPoints, 3);assert.equal(result.report.editedHeights, 2);
  assert.equal(result.report.sourceSha256, sha(fixture));assert.equal(result.report.outputSha256, sha(result.bytes));
  assert.equal(result.mediaType, "application/gpx+xml");assert.equal(result.filename, "survey-working.gpx");
  assert.equal(JSON.stringify(value.source), sourceBefore);assert.equal(JSON.stringify(value.geojson), workingBefore);
  assert.deepEqual((await originalGpxFile(value.source)).bytes, new Uint8Array(fixture));
  const again = await workingGpxFile(value, options);assert.deepEqual(again, result);
});

it("GPX1.0 and prefixed GPX1.1 retain metadata, exact time text and extensions when adding schema-ordered elevation", async () => {
  for (const version of ["1.0", "1.1"]) {
    const namespace = version === "1.0" ? "http://www.topografix.com/GPX/1/0" : "http://www.topografix.com/GPX/1/1";
    const prefix = version === "1.1" ? "g:" : "", declaration = prefix ? `xmlns:g="${namespace}"` : `xmlns="${namespace}"`;
    const source = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${prefix}gpx ${declaration} xmlns:v="https://example.test/gps" version="${version}" creator="Survey 田"><${prefix}wpt lat="0" lon="0"><${prefix}time>2026-10-16T01:02:03.123400+05:45</${prefix}time><${prefix}name>A &amp; B</${prefix}name><${prefix}extensions><v:note a="1">Keep 田</v:note></${prefix}extensions></${prefix}wpt></${prefix}gpx>`;
    const value = await input(source);value.geojson.features[0].geometry.coordinates = [1e-7, -5e-8, 1e-7];
    const result = await workingGpxFile(value, options), reopened = await parse(result.bytes);
    assert.deepEqual(reopened.geojson.features[0].geometry.coordinates, [1e-7, -5e-8, 1e-7]);
    assert.equal(reopened.source.gpxVersion, version);assert.equal(reopened.source.creator, "Survey 田");
    assert.equal(reopened.geojson.features[0].properties.name, "A & B");
    assert.equal(reopened.geojson.features[0].properties.gpx.points[0].time, "2026-10-16T01:02:03.123400+05:45");
    assert(xmlText(result.bytes).includes('standalone="yes"'));
    const document = xmlDocument(result.bytes), point = document.getElementsByTagNameNS(namespace, "wpt")[0];
    assert.equal(point.firstElementChild.localName, "ele");assert.equal(point.firstElementChild.textContent, "0.0000001");
    assert.equal(point.getAttribute("lon"), "0.0000001");assert.equal(point.getAttribute("lat"), "-0.00000005");
    assert.equal(document.getElementsByTagNameNS("https://example.test/gps", "note")[0].textContent, "Keep 田");
    assert.deepEqual((await originalGpxFile(value.source)).bytes, new TextEncoder().encode(source));
  }
});

it("writes one declaration with serializers that include or omit it, preserving stylesheet instructions", async () => {
  const stylesheet = '<?xml-stylesheet type="text/xsl" href="https://never-fetch.example.test/source.xsl"?>';
  for (const source of [xmlText(fixture), stylesheet + xmlText(fixture).replace(/^<\?xml\s[\s\S]*?\?>/, "")]) {
    for (const emitsDeclaration of [false, true]) {
      const value = await input(source);value.geojson.features[0].geometry.coordinates[0] = 85.301;
      class Serializer {
        serializeToString(document) {return (emitsDeclaration ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "") + new options.Serializer().serializeToString(document);}
      }
      const result = await workingGpxFile(value, {...options, Serializer}), text = xmlText(result.bytes);
      assert.equal((text.match(/<\?xml\s/g) ?? []).length, 1);
      assert.equal((text.match(/<\?xml-stylesheet\s/g) ?? []).length, source.startsWith(stylesheet) ? 1 : 0);
      assert.equal((await parse(result.bytes)).geojson.features[0].geometry.coordinates[0], 85.301);
      assert.deepEqual((await originalGpxFile(value.source)).bytes, new TextEncoder().encode(source));
    }
  }
});

it("XY coordinates retain original heights even after an XYZ source is edited in two dimensions", async () => {
  const value = await input();
  value.geojson.features[0].geometry.coordinates = [85.31, 27.71];
  value.geojson.features[2].geometry.coordinates = [[85.32, 27.72], [85.331, 27.731]];
  const result = await workingGpxFile(value, options), reopened = await parse(result.bytes);
  assert.deepEqual(reopened.geojson.features[0].geometry.coordinates, [85.31, 27.71, 1450.25]);
  assert.deepEqual(reopened.geojson.features[2].geometry.coordinates, [[85.32, 27.72, 1510], [85.331, 27.731, 1520]]);
  assert.equal(result.report.editedHeights, 0);assert.equal(result.report.editedPoints, 2);
});

it("rejects ambiguous feature identities, vertex counts and unsupported geometries before creating a download", async () => {
  for (const change of [
    value => {value.geojson.features[0].id = "new-id";},
    value => {value.geojson.features[1].id = value.geojson.features[0].id;},
    value => {delete value.geojson.features[0].properties.gpx;},
    value => {value.geojson.features[0].properties.gpx.sourceIndex = 1;},
    value => {value.geojson.features[2].properties.gpx.segmentIndex = 1;}
  ]) await reject(change, "gpx_export_feature_identity");
  await reject(value => {value.geojson.features.pop();}, "gpx_export_feature_set");
  await reject(value => {value.geojson.features.push({...structuredClone(value.geojson.features[0]), id: "extra"});}, "gpx_export_feature_set");
  await reject(value => {value.geojson.features[1].geometry.coordinates.push([85.4, 27.8]);}, "gpx_export_point_mapping");
  await reject(value => {value.geojson.features[1].geometry.coordinates.pop();}, "gpx_export_point_mapping");
  await reject(value => {value.geojson.features[1].geometry = {type: "Point", coordinates: [85.3, 27.7]};}, "gpx_export_point_mapping");
  await reject(value => {value.geojson.features[0].geometry = {type: "Polygon", coordinates: []};}, "gpx_export_geometry");
  const reordered = await input();reordered.geojson.features.reverse();
  const reopened = await parse((await workingGpxFile(reordered, options)).bytes);
  assert.deepEqual(reopened.geojson.features.map(feature => feature.geometry), (await parse(fixture)).geojson.features.map(feature => feature.geometry));
});

it("rejects invalid ranges, nonnumbers, nonfinite values, sparse arrays and mixed dimensions", async () => {
  for (const coordinates of [[181, 0], [0, 91], [0, 0, 100001], [0, 0, -100001], [NaN, 0], [0, Infinity], ["85", 27], [0], [0, 0, 0, 0], [0, ,], null]) {
    await reject(value => {value.geojson.features[0].geometry.coordinates = coordinates;}, "gpx_export_coordinates");
  }
  await reject(value => {value.geojson.features[1].geometry.coordinates = [[0, 0], [0, 0, 1]];}, "gpx_export_coordinates");
  await reject(value => {value.geojson.features[1].geometry.coordinates = Array(2);}, "gpx_export_coordinates");
  await reject(value => {value.geojson.features[1].geometry.coordinates = [];}, "gpx_export_coordinates");
});

it("checks source checksum, declared identity, active XML and ambiguous height fields", async () => {
  await reject(value => {value.source.originalFile.content = value.source.originalFile.content.slice(4);}, "gpx_export_source_invalid");
  await reject(value => {value.source.sha256 = "0".repeat(64);}, "gpx_export_source_invalid");
  await reject(value => {value.source.gpxVersion = "1.0";}, "gpx_export_source_identity");
  const value = await input(), hostile = new TextEncoder().encode('<!DOCTYPE gpx [<!ENTITY x SYSTEM "https://never-fetch.example.test/">]><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Fixture"><wpt lat="0" lon="0"/></gpx>');
  value.source.bytes = hostile.length;value.source.sha256 = sha(hostile);
  value.source.originalFile = {encoding: "base64", bytes: hostile.length, sha256: sha(hostile), content: Buffer.from(hostile).toString("base64")};
  await assert.rejects(workingGpxFile(value, options), error => error.code === "gpx_export_source_invalid" && error.report.sourceCode === "gpx_active_xml");
  const ambiguous = '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Fixture"><wpt lat="0" lon="0"><ele>1</ele><ele>2</ele></wpt></gpx>';
  await reject(value => {value.geojson.features[0].geometry.coordinates = [0, 0, 3];}, "gpx_export_height_mapping", ambiguous);
  await assert.rejects(workingGpxFile(await input(), {Parser: null, Serializer: null}), error => error.code === "gpx_export_xml_unavailable");
});

it("enforces feature, position, input and generated-file bounds", async () => {
  await reject(value => {value.geojson.features = Array.from({length: GPX_IMPORT_LIMITS.features + 1}, (_, i) => ({...value.geojson.features[0], id: `feature-${i}`}));}, "gpx_export_feature_limit");
  await reject(value => {value.geojson.features[1].geometry.coordinates = Array.from({length: GPX_IMPORT_LIMITS.positions + 1}, () => [0, 0]);}, "gpx_export_position_limit");
  await reject(value => {value.source.originalFile.content = "A".repeat(4 * Math.ceil(GPX_IMPORT_LIMITS.inputBytes / 3) + 4);}, "gpx_export_source_invalid");
  const point = '<trkpt lat="0" lon="0"/>', padding = '<extensions><v:p xmlns:v="https://example.test/gps">x</v:p></extensions>';
  const large = '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Fixture">' + padding + '<trk><trkseg>' + point.repeat(900) + '</trkseg></trk></gpx>';
  const value = await input(large);
  value.geojson.features[0].geometry.coordinates = value.geojson.features[0].geometry.coordinates.map(() => [5e-324, 0]);
  await assert.rejects(workingGpxFile(value, options), error => error.code === "gpx_export_output_limit" && error.report.outputBytes > GPX_IMPORT_LIMITS.inputBytes);
});

it("snapshots geometry and source before async verification", async () => {
  const value = await input(), expected = structuredClone(value.geojson);
  const pending = workingGpxFile(value, options);
  value.geojson.features[0].geometry.coordinates = [0, 0];
  value.source.gpxVersion = "tampered";value.source.originalFile.content = "tampered";
  const result = await pending, reopened = await parse(result.bytes);
  assert.deepEqual(reopened.geojson.features.map(feature => feature.geometry), expected.features.map(feature => feature.geometry));
});

it("downloads working bytes and cleans up the object URL and anchor", async () => {
  const value = await input(), previousCreate = URL.createObjectURL, previousRevoke = URL.revokeObjectURL;
  const prototype = dom.window.HTMLAnchorElement.prototype, previousClick = prototype.click;
  let blob, clicked = 0, revoked, filename;
  URL.createObjectURL = value => {blob = value;return "blob:working-gpx";};
  URL.revokeObjectURL = value => {revoked = value;};
  prototype.click = function () {clicked++;filename = this.download;assert.equal(this.parentElement, document.body);};
  try {
    const result = await downloadWorkingGpx(value, options);
    assert.equal(clicked, 1);assert.equal(filename, "survey-working.gpx");
    assert.equal(blob.type, result.mediaType);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), result.bytes);
    assert.equal(document.querySelector("a"), null);
    await new Promise(resolve => setTimeout(resolve, 5));assert.equal(revoked, "blob:working-gpx");
  } finally {URL.createObjectURL = previousCreate;URL.revokeObjectURL = previousRevoke;prototype.click = previousClick;}
});
