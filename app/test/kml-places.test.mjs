import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {strToU8, zipSync} from "fflate";
import {
  KML_PLACES_LIMITS,
  addKmlPlace,
  createPlacesDocument,
  exportKml,
  exportKmz,
  kmlRegionLodPresentation,
  moveKmlPlace,
  normalizePlacesDocument,
  parseAuthoringGeometry,
  parseKml,
  parseKmlFile,
  removeKmlPlace,
  updateKmlPlace
} from "../src/lib/kmlPlaces.js";

const DOMParser = new JSDOM("").window.DOMParser;

const RICH_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document id="field-atlas">
    <name>Field Atlas</name><visibility>1</visibility><open>1</open>
    <LookAt><longitude>13.405</longitude><latitude>52.52</latitude><altitude>100</altitude><heading>15</heading><tilt>45</tilt><range>1500</range><altitudeMode>absolute</altitudeMode></LookAt>
    <Folder id="sites"><name>Sites</name><open>1</open>
      <Placemark id="tower"><name>Tower</name><description>Survey tower</description>
        <Camera><longitude>13.405</longitude><latitude>52.52</latitude><altitude>120</altitude><heading>30</heading><tilt>55</tilt><roll>0</roll><altitudeMode>absolute</altitudeMode></Camera>
        <TimeStamp><when>2026-08-24T12:00:00Z</when></TimeStamp>
        <Style><IconStyle><color>ff00ffff</color><scale>1.2</scale><Icon><href>icons/tower.png</href></Icon></IconStyle><BalloonStyle><text>$[name]</text></BalloonStyle></Style>
        <ExtendedData><Data name="status"><value>verified</value></Data><Data name="height"><value>120</value></Data></ExtendedData>
        <Point><extrude>1</extrude><gx:altitudeMode>relativeToSeaFloor</gx:altitudeMode><coordinates>13.405,52.52,120</coordinates></Point>
      </Placemark>
      <Placemark id="route"><name>Route</name><TimeSpan><begin>2026-08-24</begin><end>2026-08-25</end></TimeSpan>
        <Style><LineStyle><color>ff00ff00</color><width>4</width></LineStyle></Style>
        <LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>13.4,52.5 13.41,52.51 13.42,52.52</coordinates></LineString>
      </Placemark>
      <Placemark id="area"><name>Area</name><Style><PolyStyle><color>7f0000ff</color><fill>1</fill><outline>1</outline></PolyStyle></Style>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>13.4,52.5 13.5,52.5 13.5,52.6 13.4,52.5</coordinates></LinearRing></outerBoundaryIs></Polygon>
      </Placemark>
      <Placemark id="mixed"><name>Mixed</name><MultiGeometry><Point><coordinates>13.44,52.54</coordinates></Point><LineString><coordinates>13.44,52.54 13.45,52.55</coordinates></LineString></MultiGeometry></Placemark>
    </Folder>
  </Document>
</kml>`;

const SHARED_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document id="shared-document">
    <name>Shared definitions</name>
    <Style id="shared-point"><IconStyle><color>ff112233</color><scale>1.5</scale><Icon><href>icons/pin.png</href></Icon></IconStyle></Style>
    <StyleMap id="point-map">
      <Pair><key>normal</key><styleUrl>#shared-point</styleUrl></Pair>
      <Pair><key>highlight</key><Style><IconStyle><color>ff00ffff</color><scale>2</scale></IconStyle></Style></Pair>
    </StyleMap>
    <Schema id="survey-schema" name="Survey">
      <SimpleField name="count" type="int"><displayName>Count</displayName></SimpleField>
      <SimpleField name="verified" type="bool"/>
      <SimpleField name="score" type="double"/>
      <SimpleField name="note" type="string"/>
    </Schema>
    <Folder id="shared-sites"><name>Shared sites</name>
      <Placemark id="typed-point"><name>Typed point</name><styleUrl>#point-map</styleUrl>
        <ExtendedData>
          <Data name="source"><value>field</value></Data>
          <SchemaData schemaUrl="#survey-schema">
            <SimpleData name="count">7</SimpleData><SimpleData name="verified">true</SimpleData>
            <SimpleData name="score">9.5</SimpleData><SimpleData name="note">ready</SimpleData>
          </SchemaData>
        </ExtendedData>
        <Point><coordinates>13.405,52.52,48</coordinates></Point>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

const OVERLAY_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document id="overlay-document"><name>Overlay atlas</name>
    <Region><LatLonAltBox><north>60</north><south>40</south><east>20</east><west>-20</west><minAltitude>0</minAltitude><maxAltitude>5000</maxAltitude><altitudeMode>absolute</altitudeMode></LatLonAltBox><Lod><minLodPixels>10</minLodPixels><maxLodPixels>-1</maxLodPixels><minFadeExtent>5</minFadeExtent><maxFadeExtent>0</maxFadeExtent></Lod></Region>
    <Folder id="overlays"><name>Overlays</name>
      <GroundOverlay id="ground"><name>Ground image</name><color>7fffffff</color><drawOrder>2</drawOrder><Icon><href>images/ground.png</href></Icon><altitude>25</altitude><altitudeMode>absolute</altitudeMode><LatLonBox><north>52.6</north><south>52.5</south><east>13.5</east><west>13.4</west><rotation>15</rotation></LatLonBox></GroundOverlay>
      <ScreenOverlay id="screen"><name>Screen legend</name><Icon><href>images/legend.png</href></Icon><overlayXY x="0" y="0" xunits="fraction" yunits="fraction"/><screenXY x="16" y="16" xunits="pixels" yunits="insetPixels"/><rotationXY x="0.5" y="0.5" xunits="fraction" yunits="fraction"/><size x="180" y="0" xunits="pixels" yunits="pixels"/><rotation>5</rotation></ScreenOverlay>
      <PhotoOverlay id="photo"><name>Photo</name><Icon><href>images/photo.jpg</href></Icon><rotation>3</rotation><ViewVolume><leftFov>-20</leftFov><rightFov>20</rightFov><bottomFov>-15</bottomFov><topFov>15</topFov><near>1</near></ViewVolume><ImagePyramid><tileSize>256</tileSize><maxWidth>1024</maxWidth><maxHeight>512</maxHeight><gridOrigin>upperLeft</gridOrigin></ImagePyramid><Point><coordinates>13.45,52.55,40</coordinates></Point><shape>rectangle</shape></PhotoOverlay>
    </Folder>
  </Document>
</kml>`;

const NETWORK_LINK_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document id="linked-atlas"><name>Linked atlas</name>
    <NetworkLink id="live-sites"><name>Live sites</name><visibility>1</visibility><open>1</open>
      <description>Governed remote KML</description>
      <Region><LatLonAltBox><north>53</north><south>52</south><east>14</east><west>13</west></LatLonAltBox><Lod><minLodPixels>64</minLodPixels><maxLodPixels>-1</maxLodPixels></Lod></Region>
      <refreshVisibility>1</refreshVisibility><flyToView>0</flyToView>
      <Link><href>https://data.opengeo.tools/places/live.kml?collection=sites</href><refreshMode>onInterval</refreshMode><refreshInterval>30</refreshInterval><viewRefreshMode>onStop</viewRefreshMode><viewRefreshTime>2</viewRefreshTime><viewBoundScale>1.25</viewBoundScale><viewFormat>BBOX=[bboxWest],[bboxSouth],[bboxEast],[bboxNorth]</viewFormat><httpQuery>client=[clientName]&amp;language=[language]</httpQuery></Link>
    </NetworkLink>
  </Document>
</kml>`;

describe("bounded KML/KMZ Places interchange", () => {
  it("imports hierarchy, camera, altitude, time, style, balloon, data, and supported geometries", () => {
    const parsed = parseKml(RICH_KML, {DOMParser});
    assert.equal(parsed.document.name, "Field Atlas");
    assert.equal(parsed.document.view.type, "LookAt");
    assert.equal(parsed.document.children[0].kind, "folder");
    assert.equal(parsed.document.children[0].children.length, 4);
    const [tower, route, area, mixed] = parsed.document.children[0].children;
    assert.deepEqual(tower.geometry.coordinates, [13.405, 52.52, 120]);
    assert.equal(tower.altitudeMode, "gx:relativeToSeaFloor");
    assert.equal(tower.view.pitch, undefined);
    assert.equal(tower.view.tilt, 55);
    assert.equal(tower.style.icon.href, "icons/tower.png");
    assert.equal(tower.style.balloon.text, "$[name]");
    assert.deepEqual(tower.extendedData, {status: "verified", height: "120"});
    assert.deepEqual(route.time, {type: "TimeSpan", begin: "2026-08-24", end: "2026-08-25"});
    assert.equal(area.geometry.type, "Polygon");
    assert.equal(mixed.geometry.type, "GeometryCollection");
    assert.equal(parsed.geojson.features.length, 4);
    assert.deepEqual(parsed.geojson.features[0].properties.folderPath, ["Sites"]);
    assert.equal(parsed.geojson.features[0].properties.kmlColor, "#ffff00");
    assert.equal(parsed.geojson.features[0].properties.kmlOpacity, 1);
    assert.equal(parsed.geojson.features[1].properties.kmlWidth, 4);
    assert.equal(parsed.report.result, "pass");
  });

  it("writes deterministic KML and preserves the supported model on re-import", () => {
    const imported = parseKml(RICH_KML, {DOMParser});
    const first = exportKml(imported.document);
    const second = exportKml(imported.document);
    assert.equal(first, second);
    const roundTrip = parseKml(first, {DOMParser});
    assert.deepEqual(roundTrip.document, normalizePlacesDocument(imported.document));
    assert.equal(roundTrip.report.result, "pass");
    assert.ok(first.indexOf("<visibility>") < first.indexOf("<open>"));
    assert.ok(first.indexOf("<open>") < first.indexOf("<LookAt>"));
  });

  it("creates, edits, groups, moves, styles, and removes bounded Places without unstable ids", () => {
    let document = createPlacesDocument({name: "Survey plan"});
    document = addKmlPlace(document, document.id, {kind: "folder", name: "Day one"});
    document = addKmlPlace(document, document.id, {kind: "folder", name: "Day two"});
    const [dayOne, dayTwo] = document.children;
    document = addKmlPlace(document, dayOne.id, {
      kind: "placemark",
      name: "Station",
      geometry: parseAuthoringGeometry("Point", "13.405,52.52,120"),
      altitudeMode: "absolute",
      style: {icon: {color: "ff00ffff", scale: 1.25}},
      extendedData: {status: "draft"}
    });
    document = addKmlPlace(document, dayOne.id, {
      kind: "placemark",
      name: "Station",
      geometry: parseAuthoringGeometry("LineString", "13.4,52.5 13.5,52.6")
    });
    const [point, line] = document.children[0].children;
    assert.equal(point.id, "station");
    assert.equal(line.id, "station-2");
    document = updateKmlPlace(document, point.id, {
      name: "Verified station",
      description: "Checked in field",
      visibility: false,
      extendedData: {status: "verified"}
    });
    document = moveKmlPlace(document, line.id, dayTwo.id, 0);
    document = removeKmlPlace(document, point.id);
    assert.equal(document.children[0].children.length, 0);
    assert.equal(document.children[1].children[0].id, "station-2");
    assert.equal(parseKml(exportKml(document), {DOMParser}).document.children[1].children[0].name, "Station");
    assert.deepEqual(parseAuthoringGeometry("Polygon", "0,0 1,0 1,1").coordinates[0], [[0, 0], [1, 0], [1, 1], [0, 0]]);
    assert.throws(() => moveKmlPlace(document, dayTwo.id, dayTwo.id), (error) => error.code === "places_parent_cycle");
  });

  it("writes and reads a bounded doc.kml KMZ without extracting unrelated resources", async () => {
    const imported = parseKml(RICH_KML, {DOMParser});
    const bytes = exportKmz(imported.document);
    const parsed = await parseKmlFile({
      name: "field-atlas.kmz",
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }, {DOMParser});
    assert.equal(parsed.source.format, "kmz");
    assert.equal(parsed.source.entry, "doc.kml");
    assert.equal(parsed.source.archiveEntries, 1);
    assert.deepEqual(parsed.document, normalizePlacesDocument(imported.document));
  });

  it("resolves shared Style/StyleMap and typed local SchemaData through deterministic KML", () => {
    const parsed = parseKml(SHARED_KML, {DOMParser});
    assert.equal(parsed.document.styles.length, 2);
    assert.equal(parsed.document.schemas.length, 1);
    assert.deepEqual(parsed.document.schemas[0].fields.map(({type}) => type), ["int", "bool", "double", "string"]);
    const place = parsed.document.children[0].children[0];
    assert.deepEqual(place.schemaData, [{
      schemaUrl: "#survey-schema",
      values: {count: 7, verified: true, score: 9.5, note: "ready"}
    }]);
    assert.equal(parsed.geojson.features[0].properties.effectiveStyle.icon.color, "ff112233");
    assert.equal(parsed.geojson.features[0].properties.kmlColor, "#332211");
    assert.equal(parsed.geojson.features[0].properties.kmlScale, 1.5);
    assert.equal(parsed.report.result, "pass");
    assert.equal(parsed.report.counts.preserved, 2);
    const exported = exportKml(parsed.document);
    assert.ok(exported.indexOf('<Style id="shared-point">') < exported.indexOf('<Schema name="Survey" id="survey-schema">'));
    assert.deepEqual(parseKml(exported, {DOMParser}).document, parsed.document);
  });

  it("preserves only referenced bounded opaque KMZ-local icon resources and rewrites nested paths", async () => {
    const icon = strToU8("deterministic-png-placeholder");
    const archive = zipSync({
      "maps/doc.kml": strToU8(SHARED_KML),
      "maps/icons/pin.png": icon,
      "unrelated/private.bin": strToU8("must-not-be-extracted")
    });
    const parsed = await parseKmlFile({
      name: "shared.kmz",
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    }, {DOMParser});
    assert.equal(parsed.document.resources.length, 1);
    assert.deepEqual(parsed.document.resources[0], {
      path: "maps/icons/pin.png",
      mediaType: "image/png",
      byteLength: icon.byteLength,
      dataBase64: btoa("deterministic-png-placeholder")
    });
    assert.equal(parsed.document.styles[0].style.icon.href, "maps/icons/pin.png");
    assert.equal(parsed.source.preservedResources, 1);
    assert.equal(parsed.source.preservedResourceBytes, icon.byteLength);
    assert.ok(parsed.report.entries.some(({path, status}) => path === "$.resources.maps/icons/pin.png" && status === "preserved"));

    const roundTripBytes = exportKmz(parsed.document);
    const roundTrip = await parseKmlFile({
      name: "round-trip.kmz",
      arrayBuffer: async () => roundTripBytes.buffer.slice(roundTripBytes.byteOffset, roundTripBytes.byteOffset + roundTripBytes.byteLength)
    }, {DOMParser});
    assert.deepEqual(roundTrip.document, parsed.document);
  });

  it("round-trips Ground, Screen, and Photo overlays with inherited Region/LOD semantics", () => {
    const parsed = parseKml(OVERLAY_KML, {DOMParser});
    const [ground, screen, photo] = parsed.document.children[0].children;
    assert.equal(ground.kind, "ground-overlay");
    assert.deepEqual(ground.box, {north: 52.6, south: 52.5, east: 13.5, west: 13.4, rotation: 15});
    assert.equal(screen.kind, "screen-overlay");
    assert.deepEqual(screen.screenXY, {x: 16, y: 16, xunits: "pixels", yunits: "insetPixels"});
    assert.equal(photo.kind, "photo-overlay");
    assert.equal(photo.imagePyramid.maxWidth, 1024);
    assert.deepEqual(photo.point, [13.45, 52.55, 40]);
    assert.equal(parsed.document.region.lod.minPixels, 10);
    assert.equal(parsed.geojson.features.length, 2);
    assert.deepEqual(parsed.geojson.features.map(({properties}) => properties.kmlOverlayKind), ["ground-overlay", "photo-overlay"]);
    assert.equal(parsed.geojson.features[0].properties.kmlRegions.length, 1);
    const exported = exportKml(parsed.document);
    assert.match(exported, /<GroundOverlay id="ground">/);
    assert.match(exported, /<ScreenOverlay id="screen">/);
    assert.match(exported, /<PhotoOverlay id="photo">/);
    assert.ok(exported.indexOf("<Region>") < exported.indexOf("<Folder id=\"overlays\">"));
    assert.deepEqual(parseKml(exported, {DOMParser}).document, parsed.document);
  });

  it("round-trips bounded NetworkLink refresh and view semantics without fetching", () => {
    const parsed = parseKml(NETWORK_LINK_KML, {DOMParser});
    const networkLink = parsed.document.children[0];
    assert.equal(networkLink.kind, "network-link");
    assert.equal(networkLink.refreshVisibility, true);
    assert.equal(networkLink.flyToView, false);
    assert.deepEqual(networkLink.link, {
      href: "https://data.opengeo.tools/places/live.kml?collection=sites",
      refreshMode: "onInterval",
      refreshInterval: 30,
      viewRefreshMode: "onStop",
      viewRefreshTime: 2,
      viewBoundScale: 1.25,
      viewFormat: "BBOX=[bboxWest],[bboxSouth],[bboxEast],[bboxNorth]",
      httpQuery: "client=[clientName]&language=[language]"
    });
    assert.equal(parsed.geojson.features.length, 0);
    const exported = exportKml(parsed.document);
    assert.match(exported, /<NetworkLink id="live-sites">/);
    assert.match(exported, /<refreshMode>onInterval<\/refreshMode>/);
    assert.match(exported, /<viewRefreshMode>onStop<\/viewRefreshMode>/);
    assert.deepEqual(parseKml(exported, {DOMParser}).document, parsed.document);
  });

  it("preserves every referenced overlay image from a nested KMZ and excludes an unrelated entry", async () => {
    const pixel = Uint8Array.from([1, 2, 3, 4]);
    const archive = zipSync({
      "nested/doc.kml": strToU8(OVERLAY_KML),
      "nested/images/ground.png": pixel,
      "nested/images/legend.png": pixel,
      "nested/images/photo.jpg": pixel,
      "unrelated/secret.png": pixel
    });
    const parsed = await parseKmlFile({
      name: "overlays.kmz",
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    }, {DOMParser});
    assert.deepEqual(parsed.document.resources.map(({path}) => path), [
      "nested/images/ground.png", "nested/images/legend.png", "nested/images/photo.jpg"
    ]);
    assert.deepEqual(parsed.document.children[0].children.map(({icon}) => icon.href), [
      "nested/images/ground.png", "nested/images/legend.png", "nested/images/photo.jpg"
    ]);
    assert.equal(parsed.source.preservedResources, 3);
    assert.equal(parsed.source.preservedResourceBytes, 12);
    const roundTrip = await parseKmlFile({
      name: "overlays-roundtrip.kmz",
      arrayBuffer: async () => {
        const bytes = exportKmz(parsed.document);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    }, {DOMParser});
    assert.deepEqual(roundTrip.document, parsed.document);
  });

  it("applies Region/LOD activation and fade extents deterministically", () => {
    const region = {
      box: {north: 1, south: -1, east: 1, west: -1, minAltitude: 0, maxAltitude: 0, altitudeMode: null},
      lod: {minPixels: 100, maxPixels: 500, minFadeExtent: 50, maxFadeExtent: 100}
    };
    assert.deepEqual(kmlRegionLodPresentation(region, 99), {active: false, opacity: 0});
    assert.deepEqual(kmlRegionLodPresentation(region, 125), {active: true, opacity: 0.5});
    assert.deepEqual(kmlRegionLodPresentation(region, 200), {active: true, opacity: 1});
    assert.deepEqual(kmlRegionLodPresentation(region, 450), {active: true, opacity: 0.5});
    assert.deepEqual(kmlRegionLodPresentation(region, 501), {active: false, opacity: 0});
  });

  it("declares cyclic shared styles and invalid or unresolved typed data without coercing them", () => {
    const parsed = parseKml(`
      <kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <StyleMap id="cycle-a"><Pair><key>normal</key><styleUrl>#cycle-b</styleUrl></Pair></StyleMap>
        <StyleMap id="cycle-b"><Pair><key>normal</key><styleUrl>#cycle-a</styleUrl></Pair></StyleMap>
        <Style id="partial"><ListStyle/><IconStyle><colorMode>random</colorMode><Icon><href>icons/local.png</href><refreshInterval>1</refreshInterval></Icon></IconStyle></Style>
        <Schema id="typed"><SimpleField name="count" type="int"/><SimpleField name="ok" type="bool"/><SimpleField name="magnitude" type="float"><unsupported/></SimpleField></Schema>
        <Placemark id="invalid"><styleUrl>#cycle-a</styleUrl><ExtendedData>
          <Data name="plain"><displayName>Plain</displayName><value>kept</value></Data>
          <SchemaData schemaUrl="#typed"><SimpleData name="count">1.25</SimpleData><SimpleData name="ok">yes</SimpleData><SimpleData name="magnitude">1e39</SimpleData><SimpleData name="unknown">7</SimpleData></SchemaData>
          <SchemaData schemaUrl="https://example.test/external.xsd"><SimpleData name="count">7</SimpleData></SchemaData>
        </ExtendedData><Point><coordinates>0,0</coordinates></Point></Placemark>
      </Document></kml>`, {DOMParser});
    assert.equal(parsed.report.result, "pass_with_declared_losses");
    assert.equal(parsed.geojson.features[0].properties.effectiveStyle, null);
    assert.deepEqual(parsed.document.children[0].schemaData, [{schemaUrl: "#typed", values: {}}]);
    assert.ok(parsed.report.entries.some(({path, status}) => path.endsWith("styleUrl") && status === "omitted"));
    assert.ok(parsed.report.entries.some(({path, detail}) => path.endsWith(".count") && detail.includes("Invalid int")));
    assert.ok(parsed.report.entries.some(({path, detail}) => path.endsWith(".ok") && detail.includes("Invalid bool")));
    assert.ok(parsed.report.entries.some(({path, detail}) => path.endsWith(".magnitude") && detail.includes("Invalid float")));
    assert.ok(parsed.report.entries.some(({detail}) => detail.includes("Unknown, unnamed, or duplicate")));
    assert.ok(parsed.report.entries.some(({detail}) => detail.includes("External or unresolved SchemaData")));
    assert.ok(parsed.report.entries.filter(({detail}) => detail.includes("outside the bounded KML subset")).length >= 4);
  });

  it("omits missing, unsupported, and oversized referenced KMZ resources with field-level evidence", async () => {
    const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Style id="missing"><IconStyle><Icon><href>icons/missing.png</href></Icon></IconStyle></Style>
      <Style id="unsupported"><IconStyle><Icon><href>icons/vector.svg</href></Icon></IconStyle></Style>
      <Style id="oversized"><IconStyle><Icon><href>icons/huge.png</href></Icon></IconStyle></Style>
      <Style id="unsafe"><IconStyle><Icon><href>../private.png</href></Icon></IconStyle></Style>
      <Placemark><styleUrl>#missing</styleUrl><Point><coordinates>0,0</coordinates></Point></Placemark>
    </Document></kml>`;
    const archive = zipSync({
      "doc.kml": strToU8(kml),
      "icons/vector.svg": strToU8("<svg/>"),
      "icons/huge.png": new Uint8Array(KML_PLACES_LIMITS.maximumKmzResourceBytes + 1)
    });
    const parsed = await parseKmlFile({
      name: "bounded-resources.kmz",
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    }, {DOMParser});
    assert.deepEqual(parsed.document.resources, []);
    assert.equal(parsed.report.result, "pass_with_declared_losses");
    for (const phrase of ["missing from the archive", "not in the bounded opaque-image allowlist", "byte limit", "Unsafe or remote icon"]) {
      assert.ok(parsed.report.entries.some(({detail}) => detail.includes(phrase)), phrase);
    }
  });

  it("emits field-level losses for unsupported or unsafe semantics", () => {
    const parsed = parseKml(`
      <kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Losses</name>
        <NetworkLink><name>Remote</name></NetworkLink>
        <GroundOverlay><name>Overlay</name></GroundOverlay>
        <gx:Tour><name>Tour</name></gx:Tour>
        <Placemark><name>Model</name><styleUrl>#shared</styleUrl><Style><IconStyle><Icon><href>https://example.test/icon.png</href></Icon></IconStyle></Style><Model/></Placemark>
      </Document></kml>`, {DOMParser});
    assert.equal(parsed.report.result, "pass_with_declared_losses");
    assert.ok(parsed.report.entries.some(({path}) => path.endsWith("NetworkLink")));
    assert.ok(parsed.report.entries.some(({path}) => path.endsWith("GroundOverlay")));
    assert.ok(parsed.report.entries.some(({path}) => path.endsWith("Tour")));
    assert.ok(parsed.report.entries.some(({path}) => path.endsWith("styleUrl")));
    assert.ok(parsed.report.entries.some(({path}) => path.endsWith("icon.href")));
    assert.ok(parsed.report.entries.some(({path}) => path.endsWith("geometry")));
    assert.equal(parsed.geojson.features.length, 0);
  });

  it("keeps unsafe NetworkLink targets inert and explicit", () => {
    for (const href of [
      "http://data.opengeo.tools/live.kml",
      "https://127.0.0.1/live.kml",
      "https://metadata.google.internal/latest/meta-data/",
      "https://user:secret@data.opengeo.tools/live.kml",
      "https://data.opengeo.tools/live.kml?token=secret",
      "../private.kml"
    ]) {
      const parsed = parseKml(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document><NetworkLink><name>Unsafe</name><Link><href>${href.replaceAll("&", "&amp;")}</href></Link></NetworkLink></Document></kml>`, {DOMParser});
      assert.equal(parsed.document.children.length, 0, href);
      assert.ok(parsed.report.entries.some(({detail}) => detail.includes("NetworkLink omitted")), href);
    }
  });

  it("rejects active XML, wrong namespaces, invalid geometry, unsafe archives, and ambiguous KMZ", async () => {
    for (const [text, code] of [
      ['<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>', "active_xml_rejected"],
      ["<kml><Document/></kml>", "kml_2_2_namespace_required"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Point><coordinates>181,0</coordinates></Point></Placemark></Document></kml>', "kml_coordinate_out_of_bounds"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>', "kml_polygon_ring_invalid"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document id="same"><Placemark id="same"><Point><coordinates>0,0</coordinates></Point></Placemark></Document></kml>', "kml_duplicate_id"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><TimeStamp><when>tomorrow</when></TimeStamp><Point><coordinates>0,0</coordinates></Point></Placemark></Document></kml>', "places_time_value_invalid"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Style><LineStyle><color>orange</color></LineStyle></Style><Point><coordinates>0,0</coordinates></Point></Placemark></Document></kml>', "places_style_color_invalid"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Region><LatLonAltBox><north>0</north><south>1</south><east>1</east><west>-1</west></LatLonAltBox></Region></Document></kml>', "kml_region_latitude_order_invalid"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><ScreenOverlay><overlayXY x="2" y="0" xunits="fraction" yunits="fraction"/></ScreenOverlay></Document></kml>', "kml_vec2_fraction_invalid"],
      ['<kml xmlns="http://www.opengis.net/kml/2.2"><Document><PhotoOverlay><Point><coordinates>0,0</coordinates></Point><shape>cube</shape></PhotoOverlay></Document></kml>', "kml_photo_overlay_shape_invalid"]
    ]) assert.throws(() => parseKml(text, {DOMParser}), (error) => error.code === code);

    for (const [archive, code] of [
      [zipSync({"../doc.kml": strToU8(RICH_KML)}), "kmz_unsafe_path"],
      [zipSync({"one.kml": strToU8(RICH_KML), "two.kml": strToU8(RICH_KML)}), "kmz_ambiguous_kml"]
    ]) await assert.rejects(() => parseKmlFile({
      name: "hostile.kmz",
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    }, {DOMParser}), (error) => error.code === code);
  });
});
