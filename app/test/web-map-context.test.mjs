import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {
  WEB_MAP_CONTEXT_LIMITS,
  exportWebMapContext,
  importWebMapContext
} from "../src/lib/webMapContext.js";

const DOMParser = new JSDOM("").window.DOMParser;

const WMC = `<?xml version="1.0" encoding="UTF-8"?>
<ViewContext xmlns="http://www.opengis.net/context"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:sld="http://www.opengis.net/sld"
  version="1.1.0" id="field-view">
  <General>
    <Window width="1280" height="720"/>
    <BoundingBox SRS="EPSG:4326" minx="-73.6" miny="41.1" maxx="-69.8" maxy="43.0"/>
    <Title>Field operations</Title>
    <KeywordList><Keyword>response</Keyword><Keyword>roads</Keyword></KeywordList>
    <Abstract>Shared operational view.</Abstract>
    <Extension><example:note xmlns:example="https://example.test/wmc">reviewed</example:note></Extension>
  </General>
  <LayerList>
    <Layer queryable="0" hidden="0">
      <Server service="OGC:WMS" version="1.1.1" title="Base service">
        <OnlineResource xlink:type="simple" xlink:href="https://maps.example.test/wms"/>
      </Server>
      <Name>workspace:base</Name>
      <Title>Base</Title>
      <SRS>EPSG:3857</SRS>
      <SRS>EPSG:4326</SRS>
      <FormatList><Format>image/jpeg</Format><Format current="1">image/png</Format></FormatList>
      <StyleList><Style current="1"><Name>default</Name><Title>Default</Title></Style></StyleList>
    </Layer>
    <Layer queryable="1" hidden="0">
      <Server service="OGC:WMS" version="1.3.0" title="Overlay service">
        <OnlineResource xlink:type="simple" xlink:href="https://user:password@maps.example.test/overlay?token=secret&amp;tenant=public"/>
      </Server>
      <Name>workspace:roads</Name>
      <Title>Roads</Title>
      <Abstract>Road centerlines.</Abstract>
      <MetadataURL format="text/html"><OnlineResource xlink:type="simple" xlink:href="https://catalog.example.test/roads"/></MetadataURL>
      <SRS>EPSG:3857</SRS>
      <FormatList><Format current="1">image/png</Format></FormatList>
      <StyleList><Style current="1"><SLD><Name>road-style</Name><Title>Road style</Title><sld:FeatureTypeStyle/></SLD></Style></StyleList>
      <DimensionList><Dimension name="TIME" units="ISO8601" unitSymbol="" userValue="2026-09-07">2026-09-01/2026-09-07/P1D</Dimension></DimensionList>
    </Layer>
    <Layer queryable="1" hidden="1">
      <Server service="OGC:WFS" version="2.0.0" title="Feature service">
        <OnlineResource xlink:type="simple" xlink:href="https://features.example.test/wfs"/>
      </Server>
      <Name>workspace:inspections</Name>
      <Title>Inspections</Title>
      <SRS>EPSG:3857</SRS>
    </Layer>
  </LayerList>
</ViewContext>`;

describe("OGC Web Map Context 1.1 interoperability", () => {
  it("imports a bounded context offline and preserves bottom-to-top draw order", () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error("WMC conversion must remain offline");
    };
    try {
      const result = importWebMapContext(WMC, {DOMParser});
      assert.equal(result.source.version, "1.1.0");
      assert.equal(result.map.name, "Field operations");
      assert.equal(result.map.description, "Shared operational view.");
      assert.deepEqual(result.map.definition.metadata.keywords, ["response", "roads"]);
      assert.deepEqual(result.map.definition.mapViews[0].bbox, [-73.6, 41.1, -69.8, 43]);
      assert.deepEqual(result.map.definition.layers.map(({title}) => title), ["Roads", "Base"]);
      assert.deepEqual(result.map.definition.layers.map(({order}) => order), [0, 1]);
      assert.equal(result.map.definition.layers[0].visible, true);
      assert.equal(result.map.definition.layers[0].sourceConfiguration.queryable, true);
      assert.equal(result.map.definition.layers[0].sourceConfiguration.styles[0], "");
      assert.equal(result.map.definition.layers[1].sourceConfiguration.styles[0], "default");
      assert.match(result.map.definition.layers[0].tileUrl, /CRS=EPSG%3A3857/);
      assert.match(result.map.definition.layers[0].tileUrl, /BBOX=\{bbox-epsg-3857\}/);
      assert.doesNotMatch(result.map.definition.layers[0].sourceUrl, /password|token=secret/);
      assert.match(result.map.definition.layers[0].sourceUrl, /tenant=public/);
      assert.equal(result.records.externalSources.length, 1);
      assert.equal(result.map.definition.extensions.wmc.layers.length, 3);
      assert.equal(result.map.definition.extensions.wmc.generalExtension.children[0].name, "note");
      assert.equal(result.report.summary.rejected, 1);
      assert.ok(result.report.summary.preserved >= 3);
      assert.ok(result.report.summary.unsupported >= 2);
      assert.equal(result.report.summary.status, "lossy");
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps HTTPS WMS layers without Web Mercator inspectable but inactive", () => {
    const result = importWebMapContext(WMC.replaceAll("<SRS>EPSG:3857</SRS>", "<SRS>EPSG:4326</SRS>"), {DOMParser});
    assert.equal(result.map.definition.layers[0].sourceType, "wms-context-reference");
    assert.equal(result.map.definition.layers[0].visible, false);
    assert.equal(result.map.definition.layers[0].tileUrl, undefined);
  });

  it("exports only WMS layers in WMC bottom-to-top order and round-trips the supported state", () => {
    const imported = importWebMapContext(WMC, {DOMParser});
    const definition = imported.map.definition;
    definition.layers.unshift({
      layerId: "local-notes",
      datasetId: "notes",
      title: "Local notes",
      sourceType: "geojson-object",
      visible: true,
      opacity: 1,
      style: {},
      labels: {enabled: false, field: null}
    });
    definition.layers.find(({title}) => title === "Roads").opacity = 0.5;

    const output = exportWebMapContext({name: imported.map.name, description: imported.map.description, definition});
    const document = new DOMParser().parseFromString(output.xml, "application/xml");
    const names = [...document.getElementsByTagNameNS("http://www.opengis.net/context", "Layer")]
      .map((layer) => [...layer.children].find(({localName}) => localName === "Name")?.textContent);
    assert.deepEqual(names, ["workspace:base", "workspace:roads"]);
    assert.match(output.xml, /version="1\.1\.0"/);
    assert.match(output.xml, /xsi:schemaLocation="http:\/\/www\.opengis\.net\/context https:\/\/schemas\.opengis\.net\/context\/1\.1\.0\/context\.xsd"/);
    assert.equal(output.report.summary.unsupported, 2);
    const roundTrip = importWebMapContext(output.xml, {DOMParser});
    assert.deepEqual(roundTrip.map.definition.layers.map(({title}) => title), ["Roads", "Base"]);
    assert.equal(roundTrip.map.definition.layers[0].visible, true);
    assert.equal(roundTrip.map.definition.layers[0].sourceConfiguration.queryable, true);
  });

  it("rejects active XML, malformed roots, invalid bounds, and the layer boundary", () => {
    assert.throws(
      () => importWebMapContext(`<!DOCTYPE ViewContext [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${WMC}`, {DOMParser}),
      ({code}) => code === "active_xml_rejected"
    );
    assert.throws(
      () => importWebMapContext(WMC.replace("http://www.opengis.net/context", "https://example.test/context"), {DOMParser}),
      ({code}) => code === "wmc_1_1_view_context_required"
    );
    assert.throws(
      () => importWebMapContext(WMC.replace('maxx="-69.8"', 'maxx="-80"'), {DOMParser}),
      ({code}) => code === "wmc_bounding_box_invalid"
    );
    const layer = WMC.match(/    <Layer queryable="0" hidden="0">[\s\S]*?    <\/Layer>/)[0];
    const tooMany = WMC.replace(/  <LayerList>[\s\S]*?  <\/LayerList>/, `  <LayerList>\n${layer.repeat(WEB_MAP_CONTEXT_LIMITS.maximumLayers + 1)}\n  </LayerList>`);
    assert.throws(() => importWebMapContext(tooMany, {DOMParser}), ({code}) => code === "wmc_layer_limit");
  });
});
