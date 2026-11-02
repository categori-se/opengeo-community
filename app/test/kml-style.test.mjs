import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {strToU8, zipSync} from "fflate";
import {exportKml, exportKmz, normalizePlacesDocument, parseKml, parseKmlFile, placesToGeojson} from "../src/lib/kmlPlaces.js";
import {kmlColorPresentation, normalizeKmlHotSpot} from "../src/lib/kmlStyle.js";

const DOMParser = new JSDOM("").window.DOMParser;
const point = '<Point><coordinates>-73,42</coordinates></Point>';
const document = body => `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;
const read = xml => parseKml(xml, {DOMParser});

test("shared and inline hotSpot retain source attributes through KML and native document roundtrips", () => {
  const xml = document(`<Style id="pin"><IconStyle><scale>1.3</scale><hotSpot x="0.5000" y="12" xunits="fraction" yunits="insetPixels"/></IconStyle></Style>
    <StyleMap id="choice"><Pair><key>normal</key><styleUrl>#pin</styleUrl></Pair></StyleMap>
    <Placemark id="site"><styleUrl>#choice</styleUrl><Style><IconStyle><hotSpot x="16" y="0" xunits="pixels" yunits="fraction"/></IconStyle></Style>${point}</Placemark>`);
  const parsed = read(xml);
  const shared = {x: "0.5000", y: "12", xunits: "fraction", yunits: "insetPixels"};
  assert.deepEqual(parsed.document.styles[0].style.icon.hotSpot, shared);
  assert.deepEqual(parsed.geojson.features[0].properties.effectiveStyle.icon.hotSpot,
    {x: "16", y: "0", xunits: "pixels", yunits: "fraction"});
  const saved = normalizePlacesDocument(JSON.parse(JSON.stringify(parsed.document)));
  assert.deepEqual(read(exportKml(saved)).document, saved);
  assert.equal(parsed.geojson.features[0].properties.kmlScale, 1.3,
    "a source scale applies without an explicit color");
  assert.ok(parsed.report.entries.some(entry => entry.path.endsWith(".hotSpot")
    && entry.detail.includes("does not apply icon anchoring")));
});

test("admitted KMZ icons and mixed hotSpot units survive actual archive export/reimport without fetching", async () => {
  const xml = document(`<Style id="pin"><IconStyle><colorMode>random</colorMode><Icon><href>icons/pin.png</href></Icon><hotSpot x="4" y="0.25" xunits="insetPixels" yunits="fraction"/></IconStyle></Style><Placemark id="site"><styleUrl>#pin</styleUrl>${point}</Placemark>`);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
  const bytes = zipSync({"doc.kml": strToU8(xml), "icons/pin.png": png});
  const parsed = await parseKmlFile({name: "pin.kmz", arrayBuffer: async () => bytes.buffer}, {DOMParser});
  const exported = exportKmz(parsed.document);
  const reopened = await parseKmlFile({name: "reopened.kmz", arrayBuffer: async () => exported.buffer}, {DOMParser});
  assert.deepEqual(reopened.document, parsed.document);
  assert.deepEqual(reopened.geojson, parsed.geojson);
  assert.equal(reopened.document.resources.length, 1);
});

test("unsupported hotSpot values remain literal and escaped, with an explicit rendering boundary", () => {
  const parsed = read(document(`<Placemark id="site"><Style><IconStyle><hotSpot x="NaN" y="&quot; onload=&quot;evil" xunits="futureUnit" unexpected="kept-in-original"/></IconStyle></Style>${point}</Placemark>`));
  const hotSpot = parsed.document.children[0].style.icon.hotSpot;
  assert.deepEqual(hotSpot, {x: "NaN", y: '" onload="evil', xunits: "futureUnit"});
  const exported = exportKml(parsed.document);
  assert.ok(exported.includes('y="&quot; onload=&quot;evil"'));
  assert.deepEqual(read(exported).document, parsed.document);
  assert.ok(parsed.report.entries.some(entry => entry.path.endsWith(".unexpected") && entry.status === "omitted"));
  assert.ok(parsed.report.entries.some(entry => entry.detail.includes("does not apply icon anchoring")));
  assert.deepEqual(read(document(`<Placemark><Style><IconStyle><hotSpot/></IconStyle></Style>${point}</Placemark>`)).document.children[0].style.icon.hotSpot, {});
});

test("hotSpot source attributes are bounded and native object values cannot become active markup", () => {
  assert.throws(() => normalizeKmlHotSpot({x: {toString: () => "0"}}), /kml_hotspot_attribute_invalid/);
  assert.throws(() => normalizeKmlHotSpot({x: Infinity}), /kml_hotspot_attribute_invalid/);
  assert.throws(() => normalizeKmlHotSpot({x: "\0"}), /kml_hotspot_attribute_invalid/);
  assert.throws(() => normalizeKmlHotSpot({x: "0", unknown: "silently lost"}), /kml_hotspot_attribute_invalid/);
  assert.throws(() => read(document(`<Placemark><Style><IconStyle><hotSpot x="${"0".repeat(129)}"/></IconStyle></Style>${point}</Placemark>`)), /kml_hotspot_attribute_too_long/);
  const whitespace = read(document(`<Placemark><Style><IconStyle><hotSpot x="a&#10;b&#9;c&#13;d"/></IconStyle></Style>${point}</Placemark>`));
  assert.deepEqual(read(exportKml(whitespace.document)).document, whitespace.document);
});

test("random colorMode produces stable bounded RGB channels and preserves source alpha and raw style", () => {
  const source = "804080c0";
  const outputs = new Set();
  for (let index = 0; index < 32; index++) {
    const seed = `site-${index}`;
    const result = kmlColorPresentation(source, "random", seed);
    assert.deepEqual(result, kmlColorPresentation(source, "random", seed));
    assert.equal(result.kmlOpacity, 0.501961);
    const channels = result.kmlColor.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
    channels.forEach((value, channel) => assert.ok(value >= 0 && value <= [192, 128, 64][channel]));
    outputs.add(result.kmlColor);
  }
  assert.ok(outputs.size > 24);
  assert.deepEqual(kmlColorPresentation("80000000", "random", "site"), {kmlColor: "#000000", kmlOpacity: 0.501961});
  assert.match(kmlColorPresentation(undefined, "random", "site").kmlColor, /^#[0-9a-f]{6}$/);
  assert.deepEqual(kmlColorPresentation(source, "normal"), {kmlColor: "#c08040", kmlOpacity: 0.501961});
});

test("Icon/Line/Poly random styles reach the existing color presentation and survive KML reimport", () => {
  const parsed = read(document(`<Style id="styles"><IconStyle><color>ff40c0ff</color><colorMode>random</colorMode></IconStyle><LineStyle><color>7fff8040</color><colorMode>random</colorMode><width>4</width></LineStyle><PolyStyle><color>ff00ff80</color><colorMode>random</colorMode></PolyStyle></Style>
    <Placemark id="point"><styleUrl>#styles</styleUrl>${point}</Placemark>
    <Placemark id="line"><styleUrl>#styles</styleUrl><LineString><coordinates>-73,42 -72,43</coordinates></LineString></Placemark>
    <Placemark id="area"><styleUrl>#styles</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>-73,42 -72,42 -72,43 -73,42</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`));
  for (const feature of parsed.geojson.features) {
    const key = {Point: "icon", LineString: "line", Polygon: "polygon"}[feature.geometry.type];
    const style = feature.properties.effectiveStyle[key];
    assert.equal(style.colorMode, "random");
    const expected = kmlColorPresentation(style.color, "random", feature.id);
    assert.equal(feature.properties.kmlColor, expected.kmlColor);
    assert.equal(feature.properties.kmlOpacity, expected.kmlOpacity);
  }
  assert.deepEqual(read(exportKml(parsed.document)).geojson, parsed.geojson);
  assert.deepEqual(placesToGeojson(JSON.parse(JSON.stringify(parsed.document))), parsed.geojson);
});

test("unknown color modes and label modes roundtrip with a declared preview fallback", () => {
  const parsed = read(document(`<Placemark id="site"><Style><IconStyle><color>ff112233</color><colorMode>futureMode</colorMode></IconStyle><LabelStyle><color>ffffffff</color><colorMode>random</colorMode></LabelStyle><ListStyle/></Style>${point}</Placemark>`));
  assert.equal(parsed.geojson.features[0].properties.kmlColor, "#332211");
  assert.equal(parsed.document.children[0].style.icon.colorMode, "futureMode");
  assert.deepEqual(read(exportKml(parsed.document)).document, parsed.document);
  assert.ok(parsed.report.entries.some(entry => entry.detail.includes("Unknown colorMode is preserved")));
  assert.ok(parsed.report.entries.some(entry => entry.detail.includes("KML label styling is not applied")));
  assert.ok(parsed.report.entries.some(entry => entry.path.endsWith("ListStyle") && entry.status === "omitted"));
});
