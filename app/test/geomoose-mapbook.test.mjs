import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {
  GEOMOOSE_MAPBOOK_LIMITS,
  exportGeoMooseMapbook,
  importGeoMooseMapbook
} from "../src/lib/geomooseMapbook.js";
import {
  PORTAL_CONFIGURATION_SCHEMA_VERSION,
  createPortalConfiguration,
  normalizePortalConfiguration
} from "../src/lib/portalConfiguration.js";
import {
  PORTAL_CATALOG_RUNTIME_LIMITS,
  analyzePortalCatalog,
  canAddPortalCatalogLayer,
  portalCatalogSourceRegistration,
  portalLayerFromGovernedSource
} from "../src/lib/portalCatalog.js";

const DOMParser = new JSDOM("").window.DOMParser;
const fixtureUrl = new URL("../../parity/fixtures/data/geomoose-3.15.2-mapbook.xml", import.meta.url);
const fixtureText = readFileSync(fixtureUrl, "utf8");

describe("GeoMoose 3.15.2 mapbook interoperability", () => {
  it("uses the exact checksum-pinned upstream desktop mapbook", () => {
    assert.equal(Buffer.byteLength(fixtureText), 23_998);
    assert.equal(
      createHash("sha256").update(fixtureText).digest("hex"),
      "1dc5a2e1ae199a2a5229f39fd6b04e30ecc88ff535b8d23298a29132e799c201"
    );
  });

  it("maps sources, grouped catalog, tools, searches, and services offline", () => {
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      throw new Error("network access is prohibited during mapbook parsing");
    };
    try {
      const result = importGeoMooseMapbook(fixtureText, {DOMParser});
      const portal = result.map.definition.portal;

      assert.equal(result.source.version, "3.0");
      assert.equal(portal.schemaVersion, PORTAL_CONFIGURATION_SCHEMA_VERSION);
      assert.equal(portal.upstream.version, "3.15.2");
      assert.equal(portal.upstream.commit, "6eb12a80c9d379b5634126da6ad047071fa85b92");
      assert.equal(portal.sources.length, 18);
      assert.equal(count(portal.catalog), 22);
      assert.equal(count(portal.tools), 17);
      assert.equal(portal.searches.length, 4);
      assert.equal(portal.services.length, 8);
      assert.equal(portal.locations.length, 0);
      assert.equal(portal.theme.id, "opengeo-default");
      assert.equal(portal.catalog.find(({title}) => title === "Overlays")?.children[0].title, "County Layers");
      assert.equal(findTool(portal.tools, "open-streetview")?.title, "3D View");
      assert.equal(findTool(portal.tools, "search-runways")?.type, "service");
      assert.equal(requests, 0);
      assert.equal(result.report.policy.networkAccess, "disabled");
      assert.equal(result.report.summary.rejected, 4);
      assert.equal(result.report.summary.status, "lossy");
      assert.ok(result.report.fields.some(({path, outcome}) => path.includes("@value") && outcome === "rejected_sensitive"));
      assert.ok(result.report.fields.some(({path, outcome, message}) => path.includes("catalogLayers")
        && outcome === "unsupported" && message.includes("blank/blank")));
      assert.ok(result.report.fields.some(({path, outcome, message}) => path.includes("catalogLayers")
        && outcome === "preserved_extension" && message.includes("governed compatibility adapter")));
      assert.doesNotMatch(JSON.stringify(result), /Your Key Here/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exports deterministic mapbook XML and reopens every supported semantic field", () => {
    const imported = importGeoMooseMapbook(fixtureText, {DOMParser});
    const first = exportGeoMooseMapbook(imported.map);
    const second = exportGeoMooseMapbook(imported.map);
    const reopened = importGeoMooseMapbook(first.xml, {DOMParser});

    assert.equal(first.xml, second.xml);
    assert.match(first.xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(first.xml, /<mapbook version="3\.0">/);
    assert.match(first.xml, /<drawer name="searches"/);
    assert.match(first.xml, /<tool name="open-streetview" title="3D View" type="service"\/>/);
    assert.doesNotMatch(first.xml, /Your Key Here/);
    assert.deepEqual(reopened.map.definition.portal, imported.map.definition.portal);
    assert.equal(first.report.summary.status, "lossless");
    assert.ok(first.report.fields.every(({path, outcome, message}) => path && outcome && message));
  });

  it("keeps locations and theme versioned while declaring their mapbook export limit", () => {
    const imported = importGeoMooseMapbook(fixtureText, {DOMParser});
    const portal = createPortalConfiguration({
      ...imported.map.definition.portal,
      revision: 2,
      locations: [{id: "home", title: "Home extent", center: [-93.2, 44.9], zoom: 8}],
      theme: {id: "field-light", title: "Field light", colorMode: "light"}
    });
    const output = exportGeoMooseMapbook({...imported.map, definition: {...imported.map.definition, portal}});

    assert.equal(portal.revision, 2);
    assert.deepEqual(portal.locations[0].center, [-93.2, 44.9]);
    assert.equal(portal.theme.colorMode, "light");
    assert.equal(output.report.summary.status, "preserved_with_extensions");
    assert.ok(output.report.fields.some(({path, outcome}) => path.endsWith("locations") && outcome === "preserved_extension"));
    assert.ok(output.report.fields.some(({path, outcome}) => path.endsWith("theme") && outcome === "preserved_extension"));
  });

  it("fails closed on active XML, malformed roots, future versions, duplicates, and limits", () => {
    assert.throws(
      () => importGeoMooseMapbook('<!DOCTYPE mapbook [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><mapbook version="3.0">&xxe;</mapbook>', {DOMParser}),
      (error) => error.code === "active_xml_rejected"
    );
    assert.throws(() => importGeoMooseMapbook("<portal/>", {DOMParser}), (error) => error.code === "geomoose_mapbook_root_required");
    assert.throws(() => importGeoMooseMapbook('<mapbook version="9.0"/>', {DOMParser}), (error) => error.code === "geomoose_mapbook_3_required");
    assert.throws(() => importGeoMooseMapbook("<mapbook", {DOMParser}), (error) => error.code === "malformed_mapbook");
    assert.throws(
      () => importGeoMooseMapbook(`<mapbook version="3.0"><map-source name="same" type="xyz"/><map-source name="same" type="wms"/></mapbook>`, {DOMParser}),
      /source names must be unique/
    );
    assert.throws(
      () => importGeoMooseMapbook(`<mapbook version="3.0"><toolbar>${'<drawer name="nested">'.repeat(GEOMOOSE_MAPBOOK_LIMITS.maximumToolDepth + 2)}${"</drawer>".repeat(GEOMOOSE_MAPBOOK_LIMITS.maximumToolDepth + 2)}</toolbar></mapbook>`, {DOMParser}),
      (error) => error.code === "mapbook_tool_depth"
    );
    assert.throws(
      () => importGeoMooseMapbook("x".repeat(GEOMOOSE_MAPBOOK_LIMITS.maximumBytes + 1), {DOMParser}),
      (error) => error.code === "mapbook_too_large"
    );
  });

  it("removes credentials from URL element text as well as attributes and parameters", () => {
    const result = importGeoMooseMapbook(
      '<mapbook version="3.0"><map-source name="private-wms" type="wms"><url>https://user:password@example.test/wms?token=secret&amp;safe=yes</url></map-source><catalog/><toolbar/></mapbook>',
      {DOMParser}
    );
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, /user|password|token|secret/);
    assert.equal(result.map.definition.portal.sources[0].element.children[0].text, "https://example.test/wms?safe=yes");
    assert.equal(result.report.summary.rejected, 1);
    assert.ok(result.report.fields.some(({path, outcome}) => path.endsWith("url[0].#text") && outcome === "rejected_sensitive"));
  });

  it("rejects invalid portal changes before they can enter a saved map", () => {
    const portal = importGeoMooseMapbook(fixtureText, {DOMParser}).map.definition.portal;
    assert.throws(() => normalizePortalConfiguration({...portal, revision: 0}), /revision/);
    assert.throws(() => normalizePortalConfiguration({...portal, theme: {...portal.theme, colorMode: "sepia"}}), /colorMode/);
    assert.throws(() => normalizePortalConfiguration({...portal, sources: [...portal.sources, portal.sources[0]]}), /source names must be unique/);
    const credentialUrl = structuredClone(portal);
    credentialUrl.sources[0].element.children.push({
      name: "url",
      attributes: {},
      text: "https://user:password@example.test/wms?token=secret",
      children: []
    });
    assert.throws(() => normalizePortalConfiguration(credentialUrl), /must not contain credentials/);
    const prototype = JSON.parse('{"schemaVersion":"opengeo.portal-configuration.1.0.0","revision":1,"sources":[{"name":"x","type":"xyz","title":"x","element":{"name":"map-source","attributes":{"__proto__":"bad"},"text":"","children":[]}}],"catalog":[],"tools":[],"searches":[],"services":[],"locations":[],"theme":{"id":"default","title":"Default","colorMode":"dark"}}');
    assert.throws(() => normalizePortalConfiguration(prototype), /invalid attribute name/);
  });

  it("resolves every exact catalog reference explicitly and extracts safe portable legends", () => {
    const portal = importGeoMooseMapbook(fixtureText, {DOMParser}).map.definition.portal;
    const analysis = analyzePortalCatalog(portal);

    assert.deepEqual(analysis.counts, {
      layers: 18,
      references: 19,
      direct: 2,
      ingest_required: 2,
      adapter_required: 13,
      unresolved: 1,
      governed: 0,
      fixture: 0,
      invalid: 0,
      displayed: 0
    });
    const sketch = analysis.entries.find(({reference}) => reference === "sketch/default");
    assert.equal(sketch.legend.kind, "configured");
    assert.match(sketch.legend.text, /Drawing and Markup layer/);
    assert.ok(sketch.legend.swatches.some(({color}) => color === "#fec44f"));
    assert.doesNotMatch(sketch.legend.text, /<[^>]+>/);
    assert.equal(analysis.entries.find(({reference}) => reference === "lmic/mncomp").legend.kind, "suppressed");
    assert.equal(analysis.entries.find(({reference}) => reference === "blank/blank").compatibility, "unresolved");
  });

  it("creates an ordinary governed exact-revision layer from compatible catalog sources", () => {
    const portal = importGeoMooseMapbook(fixtureText, {DOMParser}).map.definition.portal;
    const entry = analyzePortalCatalog(portal).entries.find(({reference}) => reference === "openstreetmap/osm_mapnik");
    const registration = portalCatalogSourceRegistration(entry);
    const source = {
      datasetId: "10000000-0000-4000-8000-000000000001",
      name: registration.name,
      sourceType: "xyz",
      sourceUrl: registration.source.url,
      versionNumber: 3,
      configuration: {
        minZoom: 0,
        maxZoom: 22,
        tileSize: 256,
        scheme: "xyz",
        attribution: "© OpenStreetMap Contributors."
      }
    };
    const layer = portalLayerFromGovernedSource(entry, source);
    const resolved = analyzePortalCatalog(portal, {layers: [layer], sources: [source]});

    assert.equal(registration.source.url, "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png");
    assert.equal(layer.datasetId, source.datasetId);
    assert.equal(layer.sourceVersion, 3);
    assert.equal(layer.portalCatalogSource, "openstreetmap/osm_mapnik");
    assert.equal(layer.governedSource, true);
    assert.equal(resolved.counts.governed, 1);
    assert.equal(resolved.counts.displayed, 1);
    assert.equal(resolved.entries.find(({reference}) => reference === layer.portalCatalogSource).binding.layer, layer);
  });

  it("builds the directly compatible WMS layer from its exact configured source", () => {
    const portal = importGeoMooseMapbook(fixtureText, {DOMParser}).map.definition.portal;
    const entry = analyzePortalCatalog(portal).entries.find(({reference}) => reference === "iastate/nexrad-n0r");
    const registration = portalCatalogSourceRegistration(entry);
    const source = {
      datasetId: "10000000-0000-4000-8000-000000000003",
      sourceType: "wms",
      sourceUrl: registration.source.url,
      versionNumber: 2,
      configuration: Object.fromEntries(Object.entries(registration.source).filter(([key]) => !["type", "url"].includes(key)))
    };
    const layer = portalLayerFromGovernedSource(entry, source);

    assert.equal(registration.source.url, "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi");
    assert.equal(layer.sourceType, "wms-raster");
    assert.match(layer.tileUrl, /^https:\/\/mesonet\.agron\.iastate\.edu\/cgi-bin\/wms\/nexrad\/n0r\.cgi\?SERVICE=WMS&/);
    assert.match(layer.tileUrl, /LAYERS=nexrad-n0r/);
    assert.match(layer.tileUrl, /BBOX=\{bbox-epsg-3857\}/);
  });

  it("keeps browser-demo bindings visibly separate from governed bindings", () => {
    const portal = importGeoMooseMapbook(fixtureText, {DOMParser}).map.definition.portal;
    const entry = analyzePortalCatalog(portal).entries.find(({reference}) => reference === "openstreetmap/osm_mapnik");
    const registration = portalCatalogSourceRegistration(entry);
    const source = {
      datasetId: "10000000-0000-4000-8000-000000000002",
      sourceType: "xyz",
      sourceUrl: registration.source.url,
      versionNumber: 1,
      configuration: {minZoom: 0, maxZoom: 22, tileSize: 256, scheme: "xyz", attribution: null},
      fixtureSource: true
    };
    const layer = portalLayerFromGovernedSource(entry, source);
    const resolved = analyzePortalCatalog(portal, {layers: [layer], sources: [source]});

    assert.equal(layer.governedSource, false);
    assert.equal(layer.fixtureSource, true);
    assert.equal(resolved.counts.governed, 0);
    assert.equal(resolved.counts.fixture, 1);
    assert.equal(resolved.counts.displayed, 0);
  });

  it("accepts the 512-node catalog boundary and rejects the next node", () => {
    const source = {
      name: "tiles",
      type: "xyz",
      title: "Tiles",
      element: {
        name: "map-source",
        attributes: {name: "tiles", type: "xyz", title: "Tiles"},
        text: "",
        children: [
          {name: "layer", attributes: {name: "default"}, text: "", children: []},
          {name: "url", attributes: {}, text: "https://tiles.example.test/{z}/{x}/{y}.png", children: []}
        ]
      }
    };
    const layer = (index) => ({
      kind: "layer",
      title: `Layer ${index}`,
      source: "tiles/default",
      attributes: {src: "tiles/default", title: `Layer ${index}`},
      metadata: [],
      children: []
    });
    const maximum = createPortalConfiguration({
      sources: [source],
      catalog: Array.from({length: 512}, (_, index) => layer(index))
    });

    assert.equal(analyzePortalCatalog(maximum).counts.layers, 512);
    assert.equal(PORTAL_CATALOG_RUNTIME_LIMITS.maximumDisplayedLayers, 256);
    assert.equal(canAddPortalCatalogLayer(255), true);
    assert.equal(canAddPortalCatalogLayer(256), false);
    assert.throws(() => canAddPortalCatalogLayer(-1), /non-negative integer/);
    assert.throws(() => createPortalConfiguration({
      sources: [source],
      catalog: Array.from({length: 513}, (_, index) => layer(index))
    }), /at most 512/);
  });
});

function count(nodes) {
  return nodes.reduce((total, node) => total + 1 + count(node.children ?? []), 0);
}

function findTool(nodes, name) {
  for (const node of nodes) {
    if (node.name === name) return node;
    const nested = findTool(node.children ?? [], name);
    if (nested) return nested;
  }
  return null;
}
